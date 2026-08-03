import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompetitionReplayValidationError } from "@/lib/competition-replay";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

const mocks = vi.hoisted(() => ({
  replayCompetition: vi.fn(),
  dispatchQueuedRuns: vi.fn().mockResolvedValue([]),
  after: vi.fn((callback: () => unknown) => callback()),
}));

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});
vi.mock("@/lib/competition-replay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/competition-replay")>()),
  replayCompetition: mocks.replayCompetition,
}));
vi.mock("@/lib/dispatch", () => ({ dispatchQueuedRuns: mocks.dispatchQueuedRuns }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: mocks.after }));

import { POST } from "./route";

const TOKEN = "test-admin-token";
const BODY = {
  competition_id: "eda31800-e401-4c40-a112-b101079dd7f4",
  expected_count: 3,
  operation_id: "7d9437f6-02fe-4da6-8d84-791b0ecf4690",
  confirm: false,
};
const MANIFEST_DIGEST = "a".repeat(64);

function request(body: unknown = BODY, headers: Record<string, string> = {}, ip = "10.0.0.1") {
  return new NextRequest("http://localhost/api/competition/admin/replay", {
    method: "POST",
    headers: { "content-type": "application/json", "x-competition-admin-token": TOKEN, "x-forwarded-for": ip, ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/competition/admin/replay", () => {
  beforeEach(() => {
    resetStorage();
    vi.clearAllMocks();
    mocks.after.mockImplementation((callback) => callback());
    mocks.dispatchQueuedRuns.mockResolvedValue([]);
    mocks.replayCompetition.mockResolvedValue({ operationId: BODY.operation_id, manifestDigest: MANIFEST_DIGEST, confirmed: false, sourceCount: 3, plannedCount: 3, createdCount: 0, sources: [{ submissionId: "s1", prompt: "never expose this" }] });
    vi.stubEnv("COMPETITION_ADMIN_TOKEN", TOKEN);
  });

  it("returns 500 before auth or storage work when the admin token is not configured", async () => {
    vi.stubEnv("COMPETITION_ADMIN_TOKEN", "");
    expect((await POST(request())).status).toBe(500);
    expect(mocks.replayCompetition).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong token and 400 for malformed replay input", async () => {
    const wrong = await POST(request(BODY, { "x-competition-admin-token": "wrong" }, "10.0.0.2"));
    const malformed = await POST(request({ ...BODY, operation_id: "not-a-uuid" }, {}, "10.0.0.3"));
    expect(wrong.status).toBe(401);
    expect(malformed.status).toBe(400);
    expect(mocks.replayCompetition).not.toHaveBeenCalled();
  });

  it("plans a dry run without dispatching and returns only a sanitized summary", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.replayCompetition).toHaveBeenCalledWith(storageRef.current, {
      competitionId: BODY.competition_id, expectedCount: 3, operationId: BODY.operation_id, confirm: false, manifestDigest: undefined,
    });
    expect(mocks.dispatchQueuedRuns).not.toHaveBeenCalled();
    const payload = await response.json();
    expect(payload).toMatchObject({ operation_id: BODY.operation_id, confirmed: false, source_count: 3, planned_count: 3, created_count: 0 });
    expect(JSON.stringify(payload)).not.toContain("never expose this");
  });

  it("confirms the exact request and dispatches only after replay storage succeeds", async () => {
    const order: string[] = [];
    mocks.replayCompetition.mockImplementation(async () => {
      order.push("replay");
      return { operationId: BODY.operation_id, confirmed: true, sourceCount: 3, plannedCount: 3, createdCount: 3 };
    });
    mocks.dispatchQueuedRuns.mockImplementation(async () => { order.push("dispatch"); return []; });

    const response = await POST(request({ ...BODY, confirm: true, manifest_digest: MANIFEST_DIGEST }, {}, "10.0.0.4"));
    expect(response.status).toBe(200);
    expect(mocks.replayCompetition).toHaveBeenCalledWith(storageRef.current, {
      competitionId: BODY.competition_id, expectedCount: 3, operationId: BODY.operation_id, confirm: true, manifestDigest: MANIFEST_DIGEST,
    });
    expect(order).toEqual(["replay", "dispatch"]);
  });

  it("maps replay validation failures to a safe 409 without dispatching", async () => {
    mocks.replayCompetition.mockRejectedValueOnce(new CompetitionReplayValidationError("submission prompt: private source text"));
    const response = await POST(request(BODY, {}, "10.0.0.5"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "replay validation failed" });
    expect(mocks.dispatchQueuedRuns).not.toHaveBeenCalled();
  });

  it("maps storage and partial-operation failures to a safe 500 with the operation id", async () => {
    mocks.replayCompetition.mockRejectedValueOnce(new Error("blob service unavailable"));
    const response = await POST(request(BODY, {}, "10.0.0.6"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "replay operation failed", operation_id: BODY.operation_id });
    expect(mocks.dispatchQueuedRuns).not.toHaveBeenCalled();
  });

  it("rate-limits before token validation, including repeated invalid token guesses", async () => {
    const ip = "10.0.0.99";
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await POST(request(BODY, { "x-competition-admin-token": "guess" }, ip))).status).toBe(401);
    }
    expect((await POST(request(BODY, { "x-competition-admin-token": "guess" }, ip))).status).toBe(429);
    expect(mocks.replayCompetition).not.toHaveBeenCalled();
  });
});
