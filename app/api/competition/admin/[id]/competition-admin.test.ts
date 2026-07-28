import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

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

describe("competition admin close and prize endpoints", () => {
  beforeEach(async () => {
    resetStorage();
    vi.stubEnv("COMPETITION_ADMIN_TOKEN", ADMIN_TOKEN);
    await storageRef.current.putCompetition(competition);
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
