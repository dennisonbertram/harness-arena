import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

vi.mock("@/lib/judge", () => ({
  judgeSubmission: vi.fn(),
  JUDGE_MODEL: "anthropic/claude-sonnet-5",
}));

vi.mock("@/lib/dispatch", () => ({
  dispatchQueuedRuns: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { judgeSubmission } from "@/lib/judge";
import { dispatchQueuedRuns } from "@/lib/dispatch";
import { auth } from "@/auth";
import { asMockAuth, githubSession } from "@/lib/test-support/auth-mock";
import { GET, POST } from "./route";

const mockAuth = asMockAuth(auth);

function postRequest(body: unknown, ip = "1.1.1.1"): NextRequest {
  return new NextRequest("http://localhost/api/submissions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function postRequestRaw(
  body: string,
  headers: Record<string, string>,
  ip = "1.1.1.1",
): NextRequest {
  return new NextRequest("http://localhost/api/submissions", {
    method: "POST",
    headers: { "x-forwarded-for": ip, ...headers },
    body,
  });
}

function mockSession(githubId: number, githubLogin = `user-${githubId}`) {
  mockAuth.mockResolvedValue(githubSession(githubId, githubLogin));
}

describe("POST /api/submissions", () => {
  // Every test gets a fresh, unique default githubId so unrelated tests never
  // collide on the new github_id rate-limit bucket (mirrors how existing
  // tests already use distinct IPs to avoid colliding on the IP bucket). A
  // single strictly-increasing counter (never reset, never offset) backs
  // every id used anywhere in this file — tests that need several distinct
  // ids within one test call freshGithubId() repeatedly rather than adding
  // ad-hoc offsets, which previously collided across tests.
  let githubIdCounter = 1000;
  function freshGithubId(): number {
    githubIdCounter += 1;
    return githubIdCounter;
  }

  beforeEach(() => {
    resetStorage();
    vi.mocked(judgeSubmission).mockReset();
    vi.mocked(dispatchQueuedRuns).mockClear();
    mockAuth.mockReset();
    mockSession(freshGithubId());
  });

  describe("auth gating", () => {
    it("returns 401 and stores nothing when there is no session", async () => {
      mockAuth.mockResolvedValueOnce(null);

      const response = await POST(postRequest({ agent_name: "agent-x", prompt: "hi" }, "10.0.0.1"));

      expect(response.status).toBe(401);
      expect(judgeSubmission).not.toHaveBeenCalled();
      expect(await storageRef.current.listSubmissions()).toHaveLength(0);
    });

    it("returns 401 when the session is missing the githubId claim (stale cookie)", async () => {
      mockAuth.mockResolvedValueOnce({ user: {}, expires: "2099-01-01T00:00:00.000Z" } as never);

      const response = await POST(postRequest({ agent_name: "agent-x", prompt: "hi" }, "10.0.0.2"));

      expect(response.status).toBe(401);
      expect(await storageRef.current.listSubmissions()).toHaveLength(0);
    });

    it("stamps the session's github_id/github_login on the stored submission, ignoring any github_login sent in the body", async () => {
      vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fine" });
      mockSession(555, "real-login");

      const response = await POST(
        postRequest(
          { agent_name: "agent-x", prompt: "hi", github_login: "spoofed-login" },
          "10.0.0.3",
        ),
      );
      const body = await response.json();

      const submission = await storageRef.current.getSubmission(body.submission_id);
      expect(submission?.github_id).toBe(555);
      expect(submission?.github_login).toBe("real-login");
    });
  });

  describe("validation", () => {
    it("accepts an empty prompt as the vanilla baseline without calling the judge", async () => {
      const response = await POST(postRequest({ agent_name: "pi-vanilla-baseline", prompt: "" }, "2.2.2.1"));

      // Empty prompt = run vanilla pi (no --system-prompt); nothing to judge.
      expect(response.status).toBe(200);
      expect(judgeSubmission).not.toHaveBeenCalled();
      const body = await response.json();
      expect(body.status).toBe("queued");
    });

    it("rejects with 400 before calling the judge when prompt exceeds 32768 chars", async () => {
      const response = await POST(
        postRequest({ agent_name: "agent-x", prompt: "a".repeat(32769) }, "2.2.2.2"),
      );

      expect(response.status).toBe(400);
      expect(judgeSubmission).not.toHaveBeenCalled();
    });

    it("rejects with 400 when agent_name is empty", async () => {
      const response = await POST(postRequest({ agent_name: "", prompt: "do stuff" }, "2.2.2.3"));
      expect(response.status).toBe(400);
    });

    it("rejects with 400 when agent_name exceeds 40 chars", async () => {
      const response = await POST(
        postRequest({ agent_name: "a".repeat(41), prompt: "do stuff" }, "2.2.2.4"),
      );
      expect(response.status).toBe(400);
    });
  });

  describe("input hardening", () => {
    it("rejects with 415 before calling the judge when content-type is not application/json", async () => {
      const response = await POST(
        postRequestRaw(JSON.stringify({ agent_name: "agent-x", prompt: "hi" }), {
          "content-type": "text/plain",
        }, "7.7.7.1"),
      );

      expect(response.status).toBe(415);
      expect(judgeSubmission).not.toHaveBeenCalled();
    });

    it("rejects with 415 when content-type header is missing entirely", async () => {
      const response = await POST(
        postRequestRaw(JSON.stringify({ agent_name: "agent-x", prompt: "hi" }), {}, "7.7.7.2"),
      );

      expect(response.status).toBe(415);
      expect(judgeSubmission).not.toHaveBeenCalled();
    });

    it("accepts a content-type with a charset suffix (application/json; charset=utf-8)", async () => {
      vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fine" });

      const response = await POST(
        postRequestRaw(JSON.stringify({ agent_name: "agent-x", prompt: "hi" }), {
          "content-type": "application/json; charset=utf-8",
        }, "7.7.7.3"),
      );

      expect(response.status).toBe(200);
    });

    it("rejects with 413 before reading the body when content-length exceeds 262144 bytes", async () => {
      const oversized = "a".repeat(300000);
      const response = await POST(
        postRequestRaw(oversized, {
          "content-type": "application/json",
          "content-length": String(oversized.length),
        }, "7.7.7.4"),
      );

      expect(response.status).toBe(413);
      expect(judgeSubmission).not.toHaveBeenCalled();
    });
  });

  describe("approved path", () => {
    it("creates 5 queued runs (not started inline) and kicks the dispatcher", async () => {
      vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "looks fair" });

      const response = await POST(
        postRequest({ agent_name: "agent-x", prompt: "Plan carefully before acting." }, "3.3.3.1"),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe("queued");
      expect(typeof body.submission_id).toBe("string");
      // A submission now spawns a fixed sample of 5 runs; run_id is the first.
      expect(Array.isArray(body.run_ids)).toBe(true);
      expect(body.run_ids).toHaveLength(5);
      expect(body.run_id).toBe(body.run_ids[0]);
      // The judge's feedback is returned on approval too, so the submitter sees it.
      expect(body.judge_reason).toBe("looks fair");

      const submission = await storageRef.current.getSubmission(body.submission_id);
      expect(submission?.status).toBe("queued");
      expect(submission?.run_id).toBe(body.run_id);
      expect(submission?.run_ids).toEqual(body.run_ids);
      expect(submission?.judge_reason).toBe("looks fair");

      // Each of the 5 runs is queued (NOT started inline), linked to the
      // submission, with a run.created event.
      for (const runId of body.run_ids) {
        const run = await storageRef.current.getRun(runId);
        expect(run?.status).toBe("queued");
        expect(run?.submission_id).toBe(body.submission_id);
        const events = await storageRef.current.listRunEvents(runId);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe("run.created");
        expect(events[0].payload).toEqual({ submission_id: body.submission_id });
      }

      // The dispatcher is kicked to start runs under the global cap.
      expect(dispatchQueuedRuns).toHaveBeenCalled();
    });

    it("a failing dispatch does not fail the submission response", async () => {
      vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fine" });
      vi.mocked(dispatchQueuedRuns).mockRejectedValueOnce(new Error("dispatch boom"));

      const response = await POST(postRequest({ agent_name: "agent-y", prompt: "Be careful." }, "3.3.3.2"));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("queued");
    });
  });

  describe("rejected path", () => {
    it("stores status=rejected and returns the judge_reason verbatim, without creating a run", async () => {
      vi.mocked(judgeSubmission).mockResolvedValueOnce({
        verdict: "rejected",
        reason: "Embeds the literal answer for a benchmark task.",
      });

      const response = await POST(
        postRequest({ agent_name: "agent-z", prompt: "For task X run: cat solution.txt" }, "4.4.4.1"),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe("rejected");
      expect(body.judge_reason).toBe("Embeds the literal answer for a benchmark task.");
      expect(body.run_id).toBeUndefined();

      const submission = await storageRef.current.getSubmission(body.submission_id);
      expect(submission?.status).toBe("rejected");
      expect(submission?.run_id).toBeUndefined();
      expect(await storageRef.current.listRuns()).toHaveLength(0);
    });
  });

  describe("judge-unavailable path", () => {
    it("returns 503 and leaves the submission pending_review when the judge throws", async () => {
      vi.mocked(judgeSubmission).mockRejectedValueOnce(new Error("gateway 500"));

      const response = await POST(
        postRequest({ agent_name: "agent-w", prompt: "A normal prompt." }, "5.5.5.1"),
      );
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.error).toContain("temporarily unavailable");
      expect(body.error).toContain("gateway 500");

      const submissions = await storageRef.current.listSubmissions();
      expect(submissions).toHaveLength(1);
      expect(submissions[0].status).toBe("pending_review");
    });
  });

  describe("rate limiting", () => {
    it("returns 429 on the 6th submission from the same IP+account within the window", async () => {
      vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "approved", reason: "fine" });
      const ip = "9.9.9.9";

      for (let i = 0; i < 5; i++) {
        const response = await POST(postRequest({ agent_name: `agent-${i}`, prompt: "hello" }, ip));
        expect(response.status).toBe(200);
      }

      const sixth = await POST(postRequest({ agent_name: "agent-6", prompt: "hello" }, ip));
      expect(sixth.status).toBe(429);
    });

    it("does not rate-limit a different IP + different account once one is exhausted", async () => {
      vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "approved", reason: "fine" });
      const exhaustedIp = "9.9.9.10";

      for (let i = 0; i < 5; i++) {
        await POST(postRequest({ agent_name: `agent-${i}`, prompt: "hello" }, exhaustedIp));
      }
      await POST(postRequest({ agent_name: "agent-over", prompt: "hello" }, exhaustedIp));

      // A fresh IP alone isn't enough to prove bucket isolation now that both
      // dimensions must admit — also switch to a fresh account.
      mockSession(freshGithubId());
      const otherResponse = await POST(
        postRequest({ agent_name: "agent-fresh", prompt: "hello" }, "9.9.9.11"),
      );
      expect(otherResponse.status).toBe(200);
    });

    it("6th submission from one IP across different github_ids is still blocked (account-minting bypass closed)", async () => {
      vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "approved", reason: "fine" });
      const ip = "9.9.9.30";

      for (let i = 0; i < 5; i++) {
        mockSession(freshGithubId());
        const response = await POST(postRequest({ agent_name: `agent-${i}`, prompt: "hello" }, ip));
        expect(response.status).toBe(200);
      }

      mockSession(freshGithubId());
      const sixth = await POST(postRequest({ agent_name: "agent-over", prompt: "hello" }, ip));
      expect(sixth.status).toBe(429);
    });

    it("6th submission from one github_id across different IPs is still blocked", async () => {
      vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "approved", reason: "fine" });
      mockSession(freshGithubId());

      for (let i = 0; i < 5; i++) {
        const response = await POST(postRequest({ agent_name: `agent-${i}`, prompt: "hello" }, `10.1.1.${i}`));
        expect(response.status).toBe(200);
      }

      const sixth = await POST(postRequest({ agent_name: "agent-over", prompt: "hello" }, "10.1.1.99"));
      expect(sixth.status).toBe(429);
    });

    describe("regression: rate limit window expiry", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it("allows a new submission from the same IP+account once the 1-hour window has fully elapsed", async () => {
        vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "approved", reason: "fine" });
        const ip = "9.9.9.20";
        const start = new Date("2026-07-21T00:00:00.000Z");
        vi.useFakeTimers();
        vi.setSystemTime(start);

        for (let i = 0; i < 5; i++) {
          const response = await POST(postRequest({ agent_name: `agent-${i}`, prompt: "hello" }, ip));
          expect(response.status).toBe(200);
        }
        const limited = await POST(postRequest({ agent_name: "agent-blocked", prompt: "hello" }, ip));
        expect(limited.status).toBe(429);

        vi.setSystemTime(new Date(start.getTime() + 61 * 60 * 1000));
        const afterWindow = await POST(
          postRequest({ agent_name: "agent-after-window", prompt: "hello" }, ip),
        );
        expect(afterWindow.status).toBe(200);
      });
    });
  });

  describe("regression: judge outcome bookkeeping", () => {
    it("persists judge_model on the submission for an approved submission", async () => {
      vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fine" });

      const response = await POST(postRequest({ agent_name: "agent-model", prompt: "hi" }, "6.6.6.1"));
      const body = await response.json();

      const submission = await storageRef.current.getSubmission(body.submission_id);
      expect(submission?.judge_model).toBe("anthropic/claude-sonnet-5");
      expect(submission?.judged_at).toBeDefined();
    });

    it("persists judge_model on the submission for a rejected submission too", async () => {
      vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "rejected", reason: "nope" });

      const response = await POST(postRequest({ agent_name: "agent-model-2", prompt: "hi" }, "6.6.6.2"));
      const body = await response.json();

      const submission = await storageRef.current.getSubmission(body.submission_id);
      expect(submission?.judge_model).toBe("anthropic/claude-sonnet-5");
    });

    it("never kicks the dispatcher when the judge rejects the submission", async () => {
      vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "rejected", reason: "cheat detected" });

      await POST(postRequest({ agent_name: "agent-reject-trigger", prompt: "cheat" }, "6.6.6.3"));

      expect(dispatchQueuedRuns).not.toHaveBeenCalled();
    });
  });

  describe("regression: dispatch still fires outside a live Next.js request scope", () => {
    it("invokes the dispatcher via the fire-and-forget fallback when next/server's after() throws " +
      "(as it does when a route handler is invoked directly, e.g. by this test harness, " +
      "instead of through a real Next.js request lifecycle)", async () => {
      vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "approved", reason: "fine" });

      const response = await POST(
        postRequest({ agent_name: "agent-after-fallback", prompt: "hello there" }, "8.8.8.1"),
      );

      expect(response.status).toBe(200);
      expect(dispatchQueuedRuns).toHaveBeenCalled();
    });
  });
});

describe("GET /api/submissions", () => {
  beforeEach(() => {
    resetStorage();
  });

  it("returns an empty array when nothing has been submitted", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("returns submissions newest first, including the full prompt text", async () => {
    await storageRef.current.putSubmission({
      id: "sub-old",
      agent_name: "old-agent",
      prompt: "old prompt text",
      status: "queued",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await storageRef.current.putSubmission({
      id: "sub-new",
      agent_name: "new-agent",
      prompt: "new prompt text",
      status: "pending_review",
      created_at: "2026-02-01T00:00:00.000Z",
    });

    const response = await GET();
    const body = await response.json();

    expect(body.map((s: { id: string }) => s.id)).toEqual(["sub-new", "sub-old"]);
    expect(body[0].prompt).toBe("new prompt text");
  });
});
