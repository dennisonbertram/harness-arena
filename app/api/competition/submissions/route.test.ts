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

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { judgeSubmission } from "@/lib/judge";
import { startRun } from "@/lib/run-trigger";
import { auth } from "@/auth";
import { asMockAuth, githubSession } from "@/lib/test-support/auth-mock";
import { defaultCompetitionId } from "@/lib/competition-leaderboard";
import { GET, POST } from "./route";
import { mintAgentToken } from "@/lib/agent-token";

const mockAuth = asMockAuth(auth);

function postRequest(body: unknown, ip = "1.1.1.1"): NextRequest {
  return new NextRequest("http://localhost/api/competition/submissions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function mockSession(githubId: number, githubLogin = `user-${githubId}`) {
  mockAuth.mockResolvedValue(githubSession(githubId, githubLogin));
}

async function putCompetition(id: string, model: string, status: "live" | "closed" = "live") {
  await storageRef.current.putCompetition({
    id,
    arena: "harness-arena",
    harness: "pi",
    model,
    prize_amount_usd: null,
    prize_cadence: null,
    status,
    created_at: "2026-07-27T00:00:00.000Z",
  });
}

describe("POST /api/competition/submissions", () => {
  // Same rationale as the main arena's test file: one strictly-increasing
  // counter backs every github_id used anywhere in this file so unrelated
  // tests never collide on the new github_id rate-limit bucket.
  let githubIdCounter = 2000;
  function freshGithubId(): number {
    githubIdCounter += 1;
    return githubIdCounter;
  }

  beforeEach(async () => {
    resetStorage();
    await putCompetition(defaultCompetitionId(), "zai/glm-5.2");
    vi.mocked(judgeSubmission).mockReset();
    vi.mocked(startRun).mockClear();
    mockAuth.mockReset();
    mockSession(freshGithubId());
  });

  describe("auth gating", () => {
    it("returns 401 and stores nothing when there is no session", async () => {
      mockAuth.mockResolvedValue(null);

      const response = await POST(postRequest({ agent_name: "agent-x", prompt: "hi" }, "20.0.0.1"));

      expect(response.status).toBe(401);
      expect(judgeSubmission).not.toHaveBeenCalled();
      expect(await storageRef.current.listSubmissions()).toHaveLength(0);
    });

    it("returns 401 when the session is missing the githubId claim", async () => {
      mockAuth.mockResolvedValue({ user: {}, expires: "2099-01-01T00:00:00.000Z" } as never);

      const response = await POST(postRequest({ agent_name: "agent-x", prompt: "hi" }, "20.0.0.2"));

      expect(response.status).toBe(401);
      expect(await storageRef.current.listSubmissions()).toHaveLength(0);
    });

    it("stamps the session's github_id/github_login on the stored submission", async () => {
      vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fine" });
      mockSession(777, "real-login");

      const response = await POST(postRequest({ agent_name: "agent-x", prompt: "hi" }, "20.0.0.3"));
      const body = await response.json();

      const submission = await storageRef.current.getSubmission(body.submission_id);
      expect(submission?.github_id).toBe(777);
      expect(submission?.github_login).toBe("real-login");
    });

    it("accepts a valid arena bearer token when no cookie session exists", async () => {
      vi.stubEnv("AUTH_SECRET", "competition-bearer-test-secret");
      mockAuth.mockResolvedValueOnce(null);
      vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fine" });
      const token = await mintAgentToken({ githubId: 902, githubLogin: "agent-user" });
      const response = await POST(new NextRequest("http://localhost/api/competition/submissions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-forwarded-for": "20.0.0.31" },
        body: JSON.stringify({ agent_name: "agent-x", prompt: "hi" }),
      }));
      const body = await response.json();
      expect(response.status).toBe(200);
      await expect(storageRef.current.getSubmission(body.submission_id)).resolves.toMatchObject({ github_id: 902, github_login: "agent-user" });
    });
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

  it("creates a submission tagged competition:true with the default competition's model and dispatches exactly 1 run", async () => {
    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fair" });

    const response = await POST(postRequest({ agent_name: "alice", prompt: "Plan carefully." }, "3.3.3.1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("queued");
    expect(body.run_ids).toEqual([body.run_id]);
    const submission = await storageRef.current.getSubmission(body.submission_id);
    expect(submission?.competition).toBe(true);
    expect(submission?.competition_id).toBe(defaultCompetitionId());
    expect(submission?.model).toBe("zai/glm-5.2");
    expect(submission?.competition_baseline).toBeUndefined();
    expect(typeof submission?.github_id).toBe("number");
    expect(typeof submission?.github_login).toBe("string");

    const runs = await storageRef.current.listRuns();
    expect(runs).toHaveLength(1);
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it("stamps a named live competition and uses that competition's model", async () => {
    await putCompetition("comp-alt-model", "anthropic/claude-sonnet-5");
    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fair" });

    const response = await POST(
      postRequest({ agent_name: "alice", prompt: "Target the alternate competition.", competition_id: "comp-alt-model" }, "3.3.3.2"),
    );
    const body = await response.json();
    const submission = await storageRef.current.getSubmission(body.submission_id);

    expect(response.status).toBe(200);
    expect(submission?.competition_id).toBe("comp-alt-model");
    expect(submission?.model).toBe("anthropic/claude-sonnet-5");
  });

  it("rejects a closed competition", async () => {
    await putCompetition("comp-closed", "anthropic/claude-sonnet-5", "closed");

    const response = await POST(
      postRequest({ agent_name: "alice", prompt: "Try closed.", competition_id: "comp-closed" }, "3.3.3.3"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "competition is closed" });
    expect(await storageRef.current.listSubmissions()).toHaveLength(0);
  });

  it("rejects an unknown competition", async () => {
    const response = await POST(
      postRequest({ agent_name: "alice", prompt: "Try unknown.", competition_id: "comp-missing" }, "3.3.3.4"),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "competition not found" });
    expect(await storageRef.current.listSubmissions()).toHaveLength(0);
  });

  it("uses the resolved default competition when competition_id is omitted", async () => {
    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fair" });

    const response = await POST(postRequest({ agent_name: "alice", prompt: "Use the default." }, "3.3.3.5"));
    const body = await response.json();
    const submission = await storageRef.current.getSubmission(body.submission_id);

    expect(response.status).toBe(200);
    expect(submission?.competition_id).toBe(defaultCompetitionId());
  });

  it("rejects a prompt byte-identical to an already-approved competition submission with 409", async () => {
    vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "approved", reason: "fair" });
    await POST(postRequest({ agent_name: "alice", prompt: "SAME PROMPT" }, "4.4.4.1"));

    const second = await POST(postRequest({ agent_name: "bob", prompt: "SAME PROMPT" }, "4.4.4.2"));
    expect(second.status).toBe(409);
  });

  // Each (arena, harness, model) triple is its own job (epic #74): a prompt
  // tuned for glm-5.2 is a legitimate, separate entry against claude-sonnet-5.
  // The duplicate guard is therefore per-competition, not global -- otherwise
  // entering one contest silently burns the prompt for every other contest.
  it("allows a prompt already used in another competition", async () => {
    vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "approved", reason: "fair" });
    await putCompetition("comp-second", "anthropic/claude-sonnet-5");
    const prompt = "Solve the task carefully and cheaply.";

    const first = await POST(postRequest({ agent_name: "alice", prompt }, "9.9.9.1"));
    expect(first.status).toBe(200);

    mockSession(freshGithubId());
    const second = await POST(
      postRequest({ agent_name: "alice", prompt, competition_id: "comp-second" }, "9.9.9.2"),
    );

    expect(second.status).toBe(200);
    const body = await second.json();
    const submission = await storageRef.current.getSubmission(body.submission_id);
    expect(submission?.competition_id).toBe("comp-second");
  });

  it("still rejects a duplicate prompt within the same competition", async () => {
    vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "approved", reason: "fair" });
    const prompt = "A repeated prompt within one contest.";
    await POST(postRequest({ agent_name: "alice", prompt }, "9.9.9.3"));

    mockSession(freshGithubId());
    const second = await POST(postRequest({ agent_name: "bob", prompt }, "9.9.9.4"));

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
      mockSession(freshGithubId());
      const response = await POST(postRequest({ agent_name: `agent-${i}`, prompt: `p-${i}` }, ip));
      expect(response.status).toBe(200);
    }
    mockSession(freshGithubId());
    const sixth = await POST(postRequest({ agent_name: "agent-over", prompt: "p-over" }, ip));
    expect(sixth.status).toBe(429);
  });

  it("returns 429 once the per-github-id limit is exceeded, even across different IPs (agent_name is no longer the identity axis)", async () => {
    vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "approved", reason: "fine" });
    mockSession(freshGithubId());
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

  it("excludes rejected submissions, never returns raw prompt text, and includes github_login", async () => {
    await storageRef.current.putSubmission({
      id: "s-ok",
      agent_name: "alice",
      prompt: "secret prompt text",
      status: "queued",
      competition: true,
      github_id: 42,
      github_login: "octocat",
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
    expect(body[0].github_login).toBe("octocat");
    expect(JSON.stringify(body)).not.toContain("secret prompt text");
    expect(JSON.stringify(body)).not.toContain("jailbreak attempt text");
  });

  it("falls back to 'unknown' github_login for an entry that lacks one (e.g. the admin-triggered baseline)", async () => {
    await storageRef.current.putSubmission({
      id: "s-baseline",
      agent_name: "pi-vanilla-baseline",
      prompt: "",
      status: "queued",
      competition: true,
      competition_baseline: true,
      created_at: "2026-07-25T00:00:00.000Z",
    });

    const response = await GET();
    const body = await response.json();

    expect(body).toHaveLength(1);
    expect(body[0].github_login).toBe("unknown");
  });
});
