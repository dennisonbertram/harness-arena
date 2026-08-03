import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

const lifecycle = vi.hoisted(() => ({ markClosed: vi.fn() }));

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});
vi.mock("@/lib/competition-entry-lifecycle-runtime", () => ({
  agentNetworkEntriesEnabled: () => process.env.AGENT_NETWORK_ENTRIES_ENABLED === "true",
  markCompetitionEntriesClosed: lifecycle.markClosed,
}));

import { POST as closeCompetition } from "./close/route";
import { PATCH as updatePrize } from "./prize/route";

const ADMIN_TOKEN = "test-admin-token";
const competition = {
  id: "competition-1",
  arena: "harness-arena",
  harness: "pi",
  model: "zai/glm-5.2",
  prize_amount_usd: null,
  prize_cadence: null,
  status: "live" as const,
  created_at: "2026-07-27T00:00:00.000Z",
};

function adminRequest(method: string, path: string, body?: unknown, ip = "3.3.3.3"): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-competition-admin-token": ADMIN_TOKEN,
      "x-forwarded-for": ip,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function unauthedRequest(method: string, path: string, token?: string, body?: unknown, ip = "3.3.3.9"): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": ip };
  if (token !== undefined) headers["x-competition-admin-token"] = token;
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("competition admin close and prize endpoints", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    resetStorage();
    vi.stubEnv("COMPETITION_ADMIN_TOKEN", ADMIN_TOKEN);
    vi.stubEnv("AGENT_NETWORK_ENTRIES_ENABLED", "false");
    lifecycle.markClosed.mockImplementation(async (input: { competition_id: string; closed_at: string }) => ({
      ...input, close_generation: "00000000-0000-0000-0000-000000000901",
    }));
    await storageRef.current.putCompetition(competition);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("fails closed when the admin token is not configured", async () => {
    vi.stubEnv("COMPETITION_ADMIN_TOKEN", "");

    const response = await closeCompetition(
      adminRequest("POST", "/api/competition/admin/competition-1/close", undefined, "3.3.3.20"),
      { params: Promise.resolve({ id: "competition-1" }) },
    );

    expect(response.status).toBe(500);
    expect((await storageRef.current.getCompetition("competition-1"))?.status).toBe("live");
  });

  it("returns not found without creating a durable lifecycle marker", async () => {
    vi.stubEnv("AGENT_NETWORK_ENTRIES_ENABLED", "true");

    const response = await closeCompetition(
      adminRequest("POST", "/api/competition/admin/missing/close", undefined, "3.3.3.21"),
      { params: Promise.resolve({ id: "missing" }) },
    );

    expect(response.status).toBe(404);
    expect(lifecycle.markClosed).not.toHaveBeenCalled();
  });

  // Without these, the token guard could be deleted from either endpoint and
  // the suite would stay green -- both existing tests send a VALID token, so
  // neither exercises rejection. These are the only tests standing between a
  // refactor and an unauthenticated close/reprice.
  it.each([
    ["missing token", undefined],
    ["wrong token", "not-the-token"],
  ])("rejects close with a %s", async (_label, token) => {
    const response = await closeCompetition(
      unauthedRequest("POST", "/api/competition/admin/competition-1/close", token),
      { params: Promise.resolve({ id: "competition-1" }) },
    );

    expect(response.status).toBe(401);
    expect((await storageRef.current.getCompetition("competition-1"))?.status).toBe("live");
  });

  it.each([
    ["missing token", undefined],
    ["wrong token", "not-the-token"],
  ])("rejects a prize update with a %s", async (_label, token) => {
    const response = await updatePrize(
      unauthedRequest("PATCH", "/api/competition/admin/competition-1/prize", token, {
        prize_amount_usd: 999,
        prize_cadence: "weekly",
      }),
      { params: Promise.resolve({ id: "competition-1" }) },
    );

    expect(response.status).toBe(401);
    expect((await storageRef.current.getCompetition("competition-1"))?.prize_amount_usd).toBeNull();
  });

  it("closes a live competition and stamps closed_at", async () => {
    const response = await closeCompetition(
      adminRequest("POST", "/api/competition/admin/competition-1/close", undefined, "3.3.3.4"),
      { params: Promise.resolve({ id: "competition-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ id: "competition-1", status: "closed" });
    expect(body.closed_at).toMatch(/^2026-\d\d-\d\dT/);
    expect(await storageRef.current.getCompetition("competition-1")).toEqual(body);
  });

  it("fails closed before mutating public storage when durable entry lifecycle coordination is enabled but unavailable", async () => {
    vi.stubEnv("AGENT_NETWORK_ENTRIES_ENABLED", "true");
    lifecycle.markClosed.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await closeCompetition(
      adminRequest("POST", "/api/competition/admin/competition-1/close", undefined, "3.3.3.14"),
      { params: Promise.resolve({ id: "competition-1" }) },
    );

    expect(response.status).toBe(503);
    expect(await storageRef.current.getCompetition("competition-1")).toEqual(competition);
  });

  it("writes the durable close marker before the public competition document and reuses its timestamp", async () => {
    vi.stubEnv("AGENT_NETWORK_ENTRIES_ENABLED", "true");
    const durableClosedAt = "2026-08-03T01:02:03.000Z";
    lifecycle.markClosed.mockImplementationOnce(async (input: { competition_id: string }) => {
      expect((await storageRef.current.getCompetition(input.competition_id))?.status).toBe("live");
      return { ...input, close_generation: "00000000-0000-0000-0000-000000000901", closed_at: durableClosedAt };
    });

    const response = await closeCompetition(
      adminRequest("POST", "/api/competition/admin/competition-1/close", undefined, "3.3.3.22"),
      { params: Promise.resolve({ id: "competition-1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "closed", closed_at: durableClosedAt });
    expect((await storageRef.current.getCompetition("competition-1"))?.closed_at).toBe(durableClosedAt);
  });

  it("rate limits repeated close attempts without changing the closed record", async () => {
    const ip = "3.3.3.23";
    const responses = [];
    for (let index = 0; index < 6; index += 1) {
      responses.push(await closeCompetition(
        adminRequest("POST", "/api/competition/admin/competition-1/close", undefined, ip),
        { params: Promise.resolve({ id: "competition-1" }) },
      ));
    }

    expect(responses.slice(0, 5).every((response) => response.status === 200)).toBe(true);
    expect(responses[5].status).toBe(429);
    expect((await storageRef.current.getCompetition("competition-1"))?.status).toBe("closed");
  });

  it("updates a prize and rejects an invalid cadence", async () => {
    const update = await updatePrize(
      adminRequest(
        "PATCH",
        "/api/competition/admin/competition-1/prize",
        { prize_amount_usd: 125, prize_cadence: "weekly" },
        "3.3.3.5",
      ),
      { params: Promise.resolve({ id: "competition-1" }) },
    );
    const updated = await update.json();

    expect(update.status).toBe(200);
    expect(updated).toMatchObject({ prize_amount_usd: 125, prize_cadence: "weekly" });
    expect(await storageRef.current.getCompetition("competition-1")).toEqual(updated);

    const invalid = await updatePrize(
      adminRequest(
        "PATCH",
        "/api/competition/admin/competition-1/prize",
        { prize_amount_usd: 125, prize_cadence: "yearly" },
        "3.3.3.6",
      ),
      { params: Promise.resolve({ id: "competition-1" }) },
    );

    expect(invalid.status).toBe(400);
    expect(await storageRef.current.getCompetition("competition-1")).toEqual(updated);
  });
});
