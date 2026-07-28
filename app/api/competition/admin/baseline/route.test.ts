import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

vi.mock("@/lib/judge", () => ({
  judgeSubmission: vi.fn(),
  JUDGE_MODEL: "anthropic/claude-sonnet-5",
}));

vi.mock("@/lib/run-trigger", () => ({
  startRun: vi.fn().mockResolvedValue(undefined),
}));

import { judgeSubmission } from "@/lib/judge";
import { startRun } from "@/lib/run-trigger";
import { defaultCompetitionId } from "@/lib/competition-leaderboard";
import { POST } from "./route";

const ADMIN_TOKEN = "test-admin-token";

function adminRequest(headers: Record<string, string> = {}, ip = "1.1.1.1", body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/competition/admin/baseline", {
    method: "POST",
    headers: {
      "x-competition-admin-token": ADMIN_TOKEN,
      "x-forwarded-for": ip,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function putCompetition(id: string, model: string) {
  await storageRef.current.putCompetition({
    id,
    arena: "harness-arena",
    harness: "pi",
    model,
    prize_amount_usd: null,
    prize_cadence: null,
    status: "live",
    created_at: "2026-07-27T00:00:00.000Z",
  });
}

describe("POST /api/competition/admin/baseline", () => {
  beforeEach(async () => {
    resetStorage();
    await putCompetition(defaultCompetitionId(), "zai/glm-5.2");
    vi.mocked(judgeSubmission).mockReset();
    vi.mocked(startRun).mockClear();
    vi.stubEnv("COMPETITION_ADMIN_TOKEN", ADMIN_TOKEN);
  });

  it("returns 500 and creates nothing when COMPETITION_ADMIN_TOKEN is unset", async () => {
    vi.stubEnv("COMPETITION_ADMIN_TOKEN", "");
    const response = await POST(adminRequest({}, "2.2.2.1"));
    expect(response.status).toBe(500);
    expect(await storageRef.current.listSubmissions()).toHaveLength(0);
  });

  it("returns 401 and creates nothing when the token is missing or wrong", async () => {
    const missing = await POST(
      new NextRequest("http://localhost/api/competition/admin/baseline", {
        method: "POST",
        headers: { "x-forwarded-for": "2.2.2.2" },
      }),
    );
    expect(missing.status).toBe(401);

    const wrong = await POST(adminRequest({ "x-competition-admin-token": "nope" }, "2.2.2.3"));
    expect(wrong.status).toBe(401);

    expect(await storageRef.current.listSubmissions()).toHaveLength(0);
  });

  it("creates a competition_baseline submission + 1 run and dispatches it when approved", async () => {
    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "vanilla, fine" });

    const response = await POST(adminRequest({}, "3.3.3.1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("queued");
    expect(typeof body.submission_id).toBe("string");
    expect(typeof body.run_id).toBe("string");
    expect(body.run_ids).toEqual([body.run_id]);

    const submission = await storageRef.current.getSubmission(body.submission_id);
    expect(submission?.competition).toBe(true);
    expect(submission?.competition_baseline).toBe(true);
    expect(submission?.competition_id).toBe(defaultCompetitionId());
    expect(submission?.model).toBe("zai/glm-5.2");

    const runs = await storageRef.current.listRuns();
    expect(runs).toHaveLength(1);
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it("creates a baseline for the named competition with that competition's model", async () => {
    await putCompetition("comp-alt-model", "anthropic/claude-sonnet-5");
    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fine" });

    const response = await POST(adminRequest({}, "3.3.3.2", { competition_id: "comp-alt-model" }));
    const body = await response.json();
    const submission = await storageRef.current.getSubmission(body.submission_id);

    expect(response.status).toBe(200);
    expect(submission?.competition_id).toBe("comp-alt-model");
    expect(submission?.model).toBe("anthropic/claude-sonnet-5");
  });

  it("allows a baseline in competition B when competition A already has one", async () => {
    await putCompetition("comp-a", "anthropic/claude-sonnet-5");
    await putCompetition("comp-b", "openai/gpt-5.2");
    await storageRef.current.putSubmission({
      id: "base-a",
      agent_name: "pi-vanilla-baseline",
      prompt: "vanilla",
      status: "queued",
      competition: true,
      competition_id: "comp-a",
      competition_baseline: true,
      run_id: "run-a",
      created_at: "2026-07-27T00:00:00.000Z",
    });
    await storageRef.current.putRun({
      id: "run-a",
      submission_id: "base-a",
      status: "queued",
      task_results: [],
      created_at: "2026-07-27T00:00:00.000Z",
    });
    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fine" });

    const response = await POST(adminRequest({}, "3.3.3.3", { competition_id: "comp-b" }));
    const body = await response.json();
    const submission = await storageRef.current.getSubmission(body.submission_id);

    expect(response.status).toBe(200);
    expect(submission?.competition_id).toBe("comp-b");
  });

  it("returns 409 and creates nothing when a live baseline already exists (run queued)", async () => {
    await storageRef.current.putSubmission({
      id: "base-1",
      agent_name: "pi-vanilla-baseline",
      prompt: "vanilla",
      status: "queued",
      competition: true,
      competition_baseline: true,
      run_id: "run-1",
      created_at: "2026-07-25T00:00:00.000Z",
    });
    await storageRef.current.putRun({
      id: "run-1",
      submission_id: "base-1",
      status: "queued",
      task_results: [],
      created_at: "2026-07-25T00:00:00.000Z",
    });

    const response = await POST(adminRequest({}, "4.4.4.1"));
    expect(response.status).toBe(409);
    expect(judgeSubmission).not.toHaveBeenCalled();
    expect(await storageRef.current.listSubmissions()).toHaveLength(1);
  });

  // Legacy-row ownership is a stable historical fact: unstamped rows belong to
  // the SEEDED competition, even after it is closed. Following the live-default
  // resolver instead would migrate them onto an unrelated competition's board
  // (see legacyOwnerId in lib/competition-leaderboard.ts), so a legacy baseline
  // must keep blocking a new baseline on the seeded competition and must NOT
  // block one on a different competition.
  it("keeps a legacy unstamped baseline with the seeded competition after it closes", async () => {
    resetStorage();
    await storageRef.current.putCompetition({
      id: defaultCompetitionId(),
      arena: "harness-arena",
      harness: "pi",
      model: "zai/glm-5.2",
      prize_amount_usd: null,
      prize_cadence: null,
      status: "closed",
      created_at: "2026-07-27T00:00:00.000Z",
    });
    await putCompetition("comp-fallback", "zai/glm-5.2");
    await storageRef.current.putSubmission({
      id: "legacy-base",
      agent_name: "pi-vanilla-baseline",
      prompt: "vanilla",
      status: "queued",
      competition: true,
      competition_baseline: true,
      run_id: "run-legacy",
      created_at: "2026-07-25T00:00:00.000Z",
    });
    await storageRef.current.putRun({
      id: "run-legacy",
      submission_id: "legacy-base",
      status: "queued",
      task_results: [],
      created_at: "2026-07-25T00:00:00.000Z",
    });

    // The legacy baseline belongs to the closed seeded competition, so the
    // separate live one is free to get its own baseline.
    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fair" });
    const response = await POST(adminRequest({}, "4.4.4.9"));

    expect(response.status).toBe(200);
  });

  it("allows a fresh baseline attempt when the prior one's run ended failed/reaped", async () => {
    await storageRef.current.putSubmission({
      id: "base-1",
      agent_name: "pi-vanilla-baseline",
      prompt: "vanilla",
      status: "queued",
      competition: true,
      competition_baseline: true,
      run_id: "run-1",
      created_at: "2026-07-25T00:00:00.000Z",
    });
    await storageRef.current.putRun({
      id: "run-1",
      submission_id: "base-1",
      status: "reaped",
      task_results: [],
      created_at: "2026-07-25T00:00:00.000Z",
    });
    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fine" });

    const response = await POST(adminRequest({}, "4.4.4.2"));
    expect(response.status).toBe(200);
    expect(await storageRef.current.listSubmissions()).toHaveLength(2);
  });

  it("allows a fresh baseline attempt when the prior one was judge-rejected", async () => {
    await storageRef.current.putSubmission({
      id: "base-1",
      agent_name: "pi-vanilla-baseline",
      prompt: "vanilla",
      status: "rejected",
      competition: true,
      competition_baseline: true,
      created_at: "2026-07-25T00:00:00.000Z",
    });
    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fine" });

    const response = await POST(adminRequest({}, "4.4.4.3"));
    expect(response.status).toBe(200);
  });

  it("stores status=rejected and creates no run when the judge rejects the vanilla prompt", async () => {
    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "rejected", reason: "unexpected rejection" });

    const response = await POST(adminRequest({}, "5.5.5.1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("rejected");
    expect(body.run_id).toBeUndefined();
    expect(await storageRef.current.listRuns()).toHaveLength(0);
  });

  it("returns 503 (not a crash) and creates no run when the judge throws", async () => {
    vi.mocked(judgeSubmission).mockRejectedValueOnce(new Error("gateway 500"));

    const response = await POST(adminRequest({}, "6.6.6.1"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toContain("gateway 500");
    expect(await storageRef.current.listRuns()).toHaveLength(0);
  });

  it("rate-limits repeated admin requests from the same IP", async () => {
    vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "rejected", reason: "throwaway" });
    const ip = "9.9.9.9";
    for (let i = 0; i < 5; i++) {
      const response = await POST(adminRequest({}, ip));
      expect(response.status).toBe(200);
    }
    const sixth = await POST(adminRequest({}, ip));
    expect(sixth.status).toBe(429);
  });

  it("rate-limits repeated WRONG-token requests too, not just valid ones (regression: token-guessing must be throttled)", async () => {
    const ip = "9.9.9.10";
    for (let i = 0; i < 5; i++) {
      const response = await POST(adminRequest({ "x-competition-admin-token": "guess" }, ip));
      expect(response.status).toBe(401);
    }
    const sixth = await POST(adminRequest({ "x-competition-admin-token": "guess" }, ip));
    expect(sixth.status).toBe(429);
    expect(judgeSubmission).not.toHaveBeenCalled();
  });

  it("accepts the correct token (timing-safe comparison doesn't break the happy path)", async () => {
    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fine" });
    const response = await POST(adminRequest({}, "9.9.9.11"));
    expect(response.status).toBe(200);
  });

  it("rejects a token of a different length than expected without throwing", async () => {
    const response = await POST(adminRequest({ "x-competition-admin-token": "short" }, "9.9.9.12"));
    expect(response.status).toBe(401);
  });
});
