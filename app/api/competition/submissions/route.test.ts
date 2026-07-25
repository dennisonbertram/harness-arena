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
import { GET, POST } from "./route";

function postRequest(body: unknown, ip = "1.1.1.1"): NextRequest {
  return new NextRequest("http://localhost/api/competition/submissions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("POST /api/competition/submissions", () => {
  beforeEach(() => {
    resetStorage();
    vi.mocked(judgeSubmission).mockReset();
    vi.mocked(startRun).mockClear();
  });

  it("rejects with 413 before reading the body when content-length exceeds 262144 bytes", async () => {
    const oversized = "a".repeat(300000);
    const response = await POST(
      new NextRequest("http://localhost/api/competition/submissions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(oversized.length),
          "x-forwarded-for": "2.2.2.0",
        },
        body: oversized,
      }),
    );
    expect(response.status).toBe(413);
    expect(judgeSubmission).not.toHaveBeenCalled();
  });

  it("rejects with 400 when agent_name or prompt is empty", async () => {
    const noAgent = await POST(postRequest({ agent_name: "", prompt: "hi" }, "2.2.2.1"));
    expect(noAgent.status).toBe(400);
    const noPrompt = await POST(postRequest({ agent_name: "x", prompt: "" }, "2.2.2.2"));
    expect(noPrompt.status).toBe(400);
  });

  it("creates a submission tagged competition:true with the fixed model and dispatches exactly 1 run", async () => {
    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fair" });

    const response = await POST(postRequest({ agent_name: "alice", prompt: "Plan carefully." }, "3.3.3.1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("queued");
    expect(body.run_ids).toEqual([body.run_id]);
    const submission = await storageRef.current.getSubmission(body.submission_id);
    expect(submission?.competition).toBe(true);
    expect(submission?.model).toBe("zai/glm-5.2");
    expect(submission?.competition_baseline).toBeUndefined();

    const runs = await storageRef.current.listRuns();
    expect(runs).toHaveLength(1);
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it("rejects a prompt byte-identical to an already-approved competition submission with 409", async () => {
    vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "approved", reason: "fair" });
    await POST(postRequest({ agent_name: "alice", prompt: "SAME PROMPT" }, "4.4.4.1"));

    const second = await POST(postRequest({ agent_name: "bob", prompt: "SAME PROMPT" }, "4.4.4.2"));
    expect(second.status).toBe(409);
  });

  it("rejects a prompt byte-identical to an already-rejected competition submission with 409", async () => {
    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "rejected", reason: "cheat" });
    await POST(postRequest({ agent_name: "alice", prompt: "CHEATY PROMPT" }, "4.4.4.3"));

    const second = await POST(postRequest({ agent_name: "bob", prompt: "CHEATY PROMPT" }, "4.4.4.4"));
    expect(second.status).toBe(409);
  });

  it("rejects a prompt byte-identical to the competition baseline's prompt with 409", async () => {
    await storageRef.current.putSubmission({
      id: "base-1",
      agent_name: "pi-vanilla-baseline",
      prompt: "BASELINE TEXT",
      status: "queued",
      competition: true,
      competition_baseline: true,
      run_id: "rb",
      created_at: "2026-07-25T00:00:00.000Z",
    });
    await storageRef.current.putRun({
      id: "rb",
      submission_id: "base-1",
      status: "completed",
      tasks_passed: 5,
      total_cost_usd: 1.0,
      task_results: [],
      created_at: "2026-07-25T00:00:00.000Z",
    });

    const response = await POST(postRequest({ agent_name: "carol", prompt: "BASELINE TEXT" }, "4.4.4.5"));
    expect(response.status).toBe(409);
    expect(judgeSubmission).not.toHaveBeenCalled();
  });

  it("allows a fresh submission of a prompt whose only prior run ended failed/reaped", async () => {
    await storageRef.current.putSubmission({
      id: "s-old",
      agent_name: "dave",
      prompt: "INFRA FLAKED",
      status: "queued",
      competition: true,
      run_id: "r-old",
      created_at: "2026-07-25T00:00:00.000Z",
    });
    await storageRef.current.putRun({
      id: "r-old",
      submission_id: "s-old",
      status: "reaped",
      task_results: [],
      created_at: "2026-07-25T00:00:00.000Z",
    });
    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fair" });

    const response = await POST(postRequest({ agent_name: "eve", prompt: "INFRA FLAKED" }, "4.4.4.6"));
    expect(response.status).toBe(200);
  });

  it("does NOT reject a prompt differing only by trailing whitespace (exact-match dedup only, v1)", async () => {
    vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "approved", reason: "fair" });
    await POST(postRequest({ agent_name: "alice", prompt: "WHITESPACE TEST" }, "4.4.4.7"));

    const response = await POST(postRequest({ agent_name: "bob", prompt: "WHITESPACE TEST " }, "4.4.4.8"));
    expect(response.status).toBe(200);
  });

  it("does NOT let a main-arena submission with identical prompt text block a competition submission", async () => {
    await storageRef.current.putSubmission({
      id: "arena-1",
      agent_name: "arena-entrant",
      prompt: "SHARED TEXT",
      status: "scored",
      created_at: "2026-07-25T00:00:00.000Z",
    });

    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fair" });
    const response = await POST(postRequest({ agent_name: "comp-entrant", prompt: "SHARED TEXT" }, "4.4.4.9"));
    expect(response.status).toBe(200);
  });

  it("stores status=rejected without creating a run when the judge rejects", async () => {
    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "rejected", reason: "embeds task answer" });

    const response = await POST(postRequest({ agent_name: "mallory", prompt: "cat solution.txt" }, "5.5.5.1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("rejected");
    expect(await storageRef.current.listRuns()).toHaveLength(0);
  });

  it("returns 429 once the per-IP limit is exceeded", async () => {
    vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "approved", reason: "fine" });
    const ip = "9.9.9.9";
    for (let i = 0; i < 5; i++) {
      const response = await POST(postRequest({ agent_name: `agent-${i}`, prompt: `p-${i}` }, ip));
      expect(response.status).toBe(200);
    }
    const sixth = await POST(postRequest({ agent_name: "agent-over", prompt: "p-over" }, ip));
    expect(sixth.status).toBe(429);
  });

  it("returns 429 once the per-agent-name limit is exceeded, even across different IPs", async () => {
    vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "approved", reason: "fine" });
    for (let i = 0; i < 5; i++) {
      const response = await POST(postRequest({ agent_name: "grinder", prompt: `p-${i}` }, `10.10.10.${i}`));
      expect(response.status).toBe(200);
    }
    const sixth = await POST(postRequest({ agent_name: "grinder", prompt: "p-over" }, "10.10.10.99"));
    expect(sixth.status).toBe(429);
  });
});

describe("GET /api/competition/submissions", () => {
  beforeEach(() => {
    resetStorage();
  });

  it("excludes rejected submissions and never returns raw prompt text", async () => {
    await storageRef.current.putSubmission({
      id: "s-ok",
      agent_name: "alice",
      prompt: "secret prompt text",
      status: "queued",
      competition: true,
      created_at: "2026-07-25T00:00:00.000Z",
    });
    await storageRef.current.putSubmission({
      id: "s-rejected",
      agent_name: "mallory",
      prompt: "jailbreak attempt text",
      status: "rejected",
      competition: true,
      created_at: "2026-07-25T00:00:00.000Z",
    });
    await storageRef.current.putSubmission({
      id: "arena-only",
      agent_name: "not-competition",
      prompt: "main arena prompt",
      status: "scored",
      created_at: "2026-07-25T00:00:00.000Z",
    });

    const response = await GET();
    const body = await response.json();

    expect(body.map((e: { submission_id: string }) => e.submission_id)).toEqual(["s-ok"]);
    expect(JSON.stringify(body)).not.toContain("secret prompt text");
    expect(JSON.stringify(body)).not.toContain("jailbreak attempt text");
  });
});
