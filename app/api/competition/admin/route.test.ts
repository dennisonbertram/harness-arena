import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

import { POST } from "./route";

const ADMIN_TOKEN = "test-admin-token";
const BODY = { arena: "harness-arena", harness: "pi", model: "zai/glm-5.2" };

function adminRequest(
  body: unknown = BODY,
  headers: Record<string, string> = {},
  ip = "1.1.1.1",
): NextRequest {
  return new NextRequest("http://localhost/api/competition/admin", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-competition-admin-token": ADMIN_TOKEN,
      "x-forwarded-for": ip,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/competition/admin", () => {
  beforeEach(() => {
    resetStorage();
    vi.stubEnv("COMPETITION_ADMIN_TOKEN", ADMIN_TOKEN);
  });

  it("rejects missing and wrong admin tokens without creating a competition", async () => {
    const missing = await POST(
      new NextRequest("http://localhost/api/competition/admin", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "2.2.2.1" },
        body: JSON.stringify(BODY),
      }),
    );
    const wrong = await POST(adminRequest(BODY, { "x-competition-admin-token": "wrong" }, "2.2.2.2"));

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await storageRef.current.listCompetitions()).toEqual([]);
  });

  it("returns 500 when the admin token is not configured", async () => {
    vi.stubEnv("COMPETITION_ADMIN_TOKEN", "");

    const response = await POST(adminRequest(BODY, {}, "2.2.2.3"));

    expect(response.status).toBe(500);
    expect(await storageRef.current.listCompetitions()).toEqual([]);
  });

  it("rejects a model outside ALLOWED_MODELS", async () => {
    const response = await POST(adminRequest({ ...BODY, model: "unlisted/model" }, {}, "2.2.2.4"));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('model "unlisted/model" is not allowed');
    expect(await storageRef.current.listCompetitions()).toEqual([]);
  });

  it("stores absent prize fields as null", async () => {
    const response = await POST(adminRequest(BODY, {}, "2.2.2.5"));
    const competition = await response.json();

    expect(response.status).toBe(201);
    expect(competition).toMatchObject({ ...BODY, prize_amount_usd: null, prize_cadence: null, status: "live" });
    expect(await storageRef.current.getCompetition(competition.id)).toMatchObject({
      prize_amount_usd: null,
      prize_cadence: null,
    });
  });

  it("creates distinct competitions for the same arena, harness, and model", async () => {
    const first = await POST(adminRequest(BODY, {}, "2.2.2.6"));
    const second = await POST(adminRequest(BODY, {}, "2.2.2.7"));
    const firstCompetition = await first.json();
    const secondCompetition = await second.json();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(firstCompetition.id).not.toBe(secondCompetition.id);
    expect(await storageRef.current.listCompetitions()).toHaveLength(2);
  });
});
