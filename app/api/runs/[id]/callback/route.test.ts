import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reapIfStale, reapThresholdMs } from "@/lib/reaper";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

import { POST } from "./route";

const SECRET = "test-runner-secret";

function callbackRequest(runId: string, body: unknown, secret: string | null = SECRET): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["x-runner-secret"] = secret;
  return new NextRequest(`http://localhost/api/runs/${runId}/callback`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/runs/[id]/callback", () => {
  const originalSecret = process.env.RUNNER_CALLBACK_SECRET;

  beforeEach(() => {
    resetStorage();
    process.env.RUNNER_CALLBACK_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.RUNNER_CALLBACK_SECRET;
    else process.env.RUNNER_CALLBACK_SECRET = originalSecret;
  });

  it("returns 401 when x-runner-secret does not match RUNNER_CALLBACK_SECRET", async () => {
    await storageRef.current.putRun({
      id: "run-1",
      submission_id: "sub-1",
      status: "queued",
      task_results: [],
      created_at: "2026-07-21T00:00:00.000Z",
    });

    const response = await POST(callbackRequest("run-1", { events: [] }, "wrong-secret"), {
      params: Promise.resolve({ id: "run-1" }),
    });

    expect(response.status).toBe(401);
  });

  it("returns 401 when x-runner-secret header is missing entirely", async () => {
    const response = await POST(callbackRequest("run-1", { events: [] }, null), {
      params: Promise.resolve({ id: "run-1" }),
    });

    expect(response.status).toBe(401);
  });

  it("appends events and transitions run status, setting finished_at when status is completed", async () => {
    await storageRef.current.putRun({
      id: "run-1",
      submission_id: "sub-1",
      status: "running",
      task_results: [],
      created_at: "2026-07-21T00:00:00.000Z",
    });

    const response = await POST(
      callbackRequest("run-1", {
        events: [
          { ts: "2026-07-21T00:01:00.000Z", type: "task.started", payload: { task_id: "t1", index: 0 } },
        ],
        status: "completed",
        task_results: [{
          task_id: "t1",
          attempted: true,
          passed: true,
          cost_usd: 0.1,
          normalized_cost_usd: 0.04,
          pricing_version: "inkling-small-2026-08-03-v1",
          input_tokens: 10,
          cache_read_tokens: 2,
          cache_write_tokens: 0,
          output_tokens: 5,
        }],
        totals: {
          tasks_passed: 1,
          total_cost_usd: 0.1,
          normalized_total_cost_usd: 0.04,
          pricing_version: "inkling-small-2026-08-03-v1",
          over_budget: false,
        },
      }),
      { params: Promise.resolve({ id: "run-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.seq_assigned).toEqual([1]);

    const run = await storageRef.current.getRun("run-1");
    expect(run?.status).toBe("completed");
    expect(run?.tasks_passed).toBe(1);
    expect(run?.total_cost_usd).toBe(0.1);
    expect(run?.normalized_total_cost_usd).toBe(0.04);
    expect(run?.pricing_version).toBe("inkling-small-2026-08-03-v1");
    expect(run?.task_results[0]).toMatchObject({
      normalized_cost_usd: 0.04,
      pricing_version: "inkling-small-2026-08-03-v1",
      input_tokens: 10,
      cache_read_tokens: 2,
      cache_write_tokens: 0,
      output_tokens: 5,
    });
    expect(run?.finished_at).toBeDefined();

    const events = await storageRef.current.listRunEvents("run-1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("task.started");
  });

  it("returns 404 when the run does not exist", async () => {
    const response = await POST(callbackRequest("unknown-run", { events: [] }), {
      params: Promise.resolve({ id: "unknown-run" }),
    });

    expect(response.status).toBe(404);
  });

  describe("regression: task.cost_tamper_signal event type (issue #23 finding A)", () => {
    it("accepts a batch containing a task.cost_tamper_signal event instead of 400ing the whole callback", async () => {
      await storageRef.current.putRun({
        id: "run-tamper",
        submission_id: "sub-tamper",
        status: "running",
        task_results: [],
        created_at: "2026-07-21T00:00:00.000Z",
      });

      const response = await POST(
        callbackRequest("run-tamper", {
          events: [
            {
              ts: "2026-07-21T00:01:00.000Z",
              type: "task.cost_tamper_signal",
              payload: { task_id: "t1", reason: "cost_unmeasured" },
            },
          ],
        }),
        { params: Promise.resolve({ id: "run-tamper" }) },
      );

      expect(response.status).toBe(200);
      const events = await storageRef.current.listRunEvents("run-tamper");
      expect(events.some((e) => e.type === "task.cost_tamper_signal")).toBe(true);
    });
  });

  describe("gateway correlation event", () => {
    it("accepts and persists the runner's provider-routing evidence", async () => {
      await storageRef.current.putRun({
        id: "run-gateway-correlation",
        submission_id: "sub-gateway-correlation",
        status: "running",
        task_results: [],
        created_at: "2026-07-31T00:00:00.000Z",
      });

      const response = await POST(
        callbackRequest("run-gateway-correlation", {
          events: [
            {
              ts: "2026-07-31T00:01:00.000Z",
              type: "task.gateway_correlation",
              payload: {
                task_id: "t1",
                proxy_requests: [
                  {
                    request_id: "gw-1",
                    pinned_provider: "fireworks",
                    status: 200,
                    response_id: "gen-1",
                  },
                ],
                pi_response_ids: ["gen-1"],
                pi_retry_events: [],
              },
            },
          ],
        }),
        { params: Promise.resolve({ id: "run-gateway-correlation" }) },
      );

      expect(response.status).toBe(200);
      const events = await storageRef.current.listRunEvents("run-gateway-correlation");
      expect(events.find((event) => event.type === "task.gateway_correlation")?.payload).toMatchObject({
        task_id: "t1",
        proxy_requests: [{ pinned_provider: "fireworks", status: 200 }],
      });
    });
  });

  describe("status transition table", () => {
    it("allows a direct queued->completed transition (belt-and-suspenders if the running post is lost)", async () => {
      await storageRef.current.putRun({
        id: "run-direct-complete",
        submission_id: "sub-direct-complete",
        status: "queued",
        task_results: [],
        created_at: "2026-07-21T00:00:00.000Z",
      });

      const response = await POST(
        callbackRequest("run-direct-complete", {
          events: [],
          status: "completed",
          task_results: [{ task_id: "t1", attempted: true, passed: true }],
          totals: { tasks_passed: 1, total_cost_usd: 0.1, over_budget: false },
        }),
        { params: Promise.resolve({ id: "run-direct-complete" }) },
      );

      expect(response.status).toBe(200);
      const run = await storageRef.current.getRun("run-direct-complete");
      expect(run?.status).toBe("completed");
    });

    it("allows a direct queued->failed transition (belt-and-suspenders if the running post is lost)", async () => {
      await storageRef.current.putRun({
        id: "run-direct-fail",
        submission_id: "sub-direct-fail",
        status: "queued",
        task_results: [],
        created_at: "2026-07-21T00:00:00.000Z",
      });

      const response = await POST(
        callbackRequest("run-direct-fail", { events: [], status: "failed" }),
        { params: Promise.resolve({ id: "run-direct-fail" }) },
      );

      expect(response.status).toBe(200);
      const run = await storageRef.current.getRun("run-direct-fail");
      expect(run?.status).toBe("failed");
    });

    it("rejects a completed->running regression: run stays completed and a warn is logged, but the event is still appended", async () => {
      await storageRef.current.putRun({
        id: "run-terminal",
        submission_id: "sub-terminal",
        status: "completed",
        task_results: [],
        created_at: "2026-07-21T00:00:00.000Z",
      });
      await storageRef.current.putSubmission({
        id: "sub-terminal",
        agent_name: "agent-t",
        prompt: "p",
        status: "scored",
        created_at: "2026-07-21T00:00:00.000Z",
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const response = await POST(
        callbackRequest("run-terminal", {
          events: [{ ts: "2026-07-21T00:05:00.000Z", type: "run.reaped", payload: {} }],
          status: "running",
        }),
        { params: Promise.resolve({ id: "run-terminal" }) },
      );

      expect(response.status).toBe(200);
      const run = await storageRef.current.getRun("run-terminal");
      expect(run?.status).toBe("completed");

      const events = await storageRef.current.listRunEvents("run-terminal");
      expect(events).toHaveLength(1);

      const logged = logSpy.mock.calls.map((call) => JSON.parse(call[0] as string));
      expect(
        logged.some((entry) => entry.level === "warn" && entry.event === "callback.invalid_transition"),
      ).toBe(true);
      logSpy.mockRestore();
    });

    it("syncs the parent submission status through queued -> running -> completed as the run transitions", async () => {
      await storageRef.current.putRun({
        id: "run-sync",
        submission_id: "sub-sync",
        status: "queued",
        task_results: [],
        created_at: "2026-07-21T00:00:00.000Z",
      });
      await storageRef.current.putSubmission({
        id: "sub-sync",
        agent_name: "agent-s",
        prompt: "p",
        status: "queued",
        run_id: "run-sync",
        created_at: "2026-07-21T00:00:00.000Z",
      });

      await POST(
        callbackRequest("run-sync", {
          events: [{ ts: "2026-07-21T00:01:00.000Z", type: "run.sandbox_ready", payload: {} }],
          status: "running",
        }),
        { params: Promise.resolve({ id: "run-sync" }) },
      );
      expect((await storageRef.current.getSubmission("sub-sync"))?.status).toBe("running");

      await POST(
        callbackRequest("run-sync", {
          events: [{ ts: "2026-07-21T00:02:00.000Z", type: "run.completed", payload: {} }],
          status: "completed",
          task_results: [{ task_id: "t1", attempted: true, passed: true, cost_usd: 0.1 }],
          totals: { tasks_passed: 1, total_cost_usd: 0.1, over_budget: false },
        }),
        { params: Promise.resolve({ id: "run-sync" }) },
      );
      expect((await storageRef.current.getSubmission("sub-sync"))?.status).toBe("scored");
    });

    it("syncs the parent submission status to failed when the run fails", async () => {
      await storageRef.current.putRun({
        id: "run-fail",
        submission_id: "sub-fail",
        status: "running",
        task_results: [],
        created_at: "2026-07-21T00:00:00.000Z",
      });
      await storageRef.current.putSubmission({
        id: "sub-fail",
        agent_name: "agent-f",
        prompt: "p",
        status: "running",
        run_id: "run-fail",
        created_at: "2026-07-21T00:00:00.000Z",
      });

      await POST(
        callbackRequest("run-fail", {
          events: [{ ts: "2026-07-21T00:02:00.000Z", type: "run.failed", payload: {} }],
          status: "failed",
        }),
        { params: Promise.resolve({ id: "run-fail" }) },
      );
      expect((await storageRef.current.getSubmission("sub-fail"))?.status).toBe("failed");
    });
  });

  describe("completed-requires-results schema refinement", () => {
    it("returns 400 when status is completed but totals/task_results are omitted", async () => {
      await storageRef.current.putRun({
        id: "run-incomplete",
        submission_id: "sub-incomplete",
        status: "running",
        task_results: [],
        created_at: "2026-07-21T00:00:00.000Z",
      });

      const response = await POST(
        callbackRequest("run-incomplete", { events: [], status: "completed" }),
        { params: Promise.resolve({ id: "run-incomplete" }) },
      );

      expect(response.status).toBe(400);
      const run = await storageRef.current.getRun("run-incomplete");
      expect(run?.status).toBe("running");
    });

    it("accepts status completed when both totals and task_results are present", async () => {
      await storageRef.current.putRun({
        id: "run-complete-ok",
        submission_id: "sub-complete-ok",
        status: "running",
        task_results: [],
        created_at: "2026-07-21T00:00:00.000Z",
      });

      const response = await POST(
        callbackRequest("run-complete-ok", {
          events: [],
          status: "completed",
          task_results: [{ task_id: "t1", attempted: true, passed: true }],
          totals: { tasks_passed: 1, total_cost_usd: 0.2, over_budget: false },
        }),
        { params: Promise.resolve({ id: "run-complete-ok" }) },
      );

      expect(response.status).toBe(200);
    });
  });

  describe("regression: a reaped run (ticket #7's reaper) is not resurrected by a late callback", () => {
    it("stays reaped when a callback later reports status=running -- the reaper already won the race", async () => {
      await storageRef.current.putRun({
        id: "run-raced",
        submission_id: "sub-raced",
        status: "running",
        task_results: [],
        created_at: "2026-07-21T00:00:00.000Z",
      });

      // Simulate the reaper (GET /api/runs[/id]'s lazy reap, or the daily
      // cron) having already marked this run stale before a straggling
      // callback from the sandbox arrives.
      const reaped = await reapIfStale(
        storageRef.current,
        (await storageRef.current.getRun("run-raced"))!,
        new Date("2026-07-21T00:00:00.000Z").getTime() + reapThresholdMs() + 1000,
      );
      expect(reaped.status).toBe("reaped");

      const response = await POST(
        callbackRequest("run-raced", {
          events: [{ ts: "2026-07-21T00:12:00.000Z", type: "task.started", payload: { task_id: "t1", index: 0 } }],
          status: "running",
        }),
        { params: Promise.resolve({ id: "run-raced" }) },
      );

      expect(response.status).toBe(200);
      const run = await storageRef.current.getRun("run-raced");
      expect(run?.status).toBe("reaped");
    });
  });

  describe("regression: partial updates do not clobber unrelated Run fields", () => {
    it("appending events with no status/totals leaves the existing run status untouched", async () => {
      await storageRef.current.putRun({
        id: "run-2",
        submission_id: "sub-2",
        status: "running",
        tasks_passed: 3,
        total_cost_usd: 0.5,
        task_results: [],
        created_at: "2026-07-21T00:00:00.000Z",
      });

      await POST(
        callbackRequest("run-2", {
          events: [{ ts: "2026-07-21T00:02:00.000Z", type: "task.verify_started", payload: { task_id: "t2" } }],
        }),
        { params: Promise.resolve({ id: "run-2" }) },
      );

      const run = await storageRef.current.getRun("run-2");
      expect(run?.status).toBe("running");
      expect(run?.tasks_passed).toBe(3);
      expect(run?.total_cost_usd).toBe(0.5);
      expect(run?.finished_at).toBeUndefined();
    });

    it("seq is monotonic across two separate callback POSTs to the same run, not restarting at 1", async () => {
      await storageRef.current.putRun({
        id: "run-3",
        submission_id: "sub-3",
        status: "running",
        task_results: [],
        created_at: "2026-07-21T00:00:00.000Z",
      });

      const first = await POST(
        callbackRequest("run-3", {
          events: [{ ts: "2026-07-21T00:00:00.000Z", type: "run.sandbox_creating", payload: {} }],
        }),
        { params: Promise.resolve({ id: "run-3" }) },
      );
      expect((await first.json()).seq_assigned).toEqual([1]);

      const second = await POST(
        callbackRequest("run-3", {
          events: [
            { ts: "2026-07-21T00:00:01.000Z", type: "run.sandbox_ready", payload: { sandbox_id: "sb-1" } },
            { ts: "2026-07-21T00:00:02.000Z", type: "task.started", payload: { task_id: "t1", index: 0 } },
          ],
        }),
        { params: Promise.resolve({ id: "run-3" }) },
      );
      expect((await second.json()).seq_assigned).toEqual([2, 3]);
    });
  });

  // Absence of provider_pinned is the marker that a run predates pinning, so
  // the field has to actually round-trip rather than being silently dropped.
  it("records which gateway provider the run was pinned to", async () => {
    await storageRef.current.putRun({
      id: "run-pinned",
      submission_id: "sub-1",
      status: "running",
      task_results: [],
      created_at: "2026-07-21T00:00:00.000Z",
    });

    const response = await POST(
      callbackRequest("run-pinned", {
        events: [],
        status: "completed",
        totals: { tasks_passed: 3, total_cost_usd: 1, over_budget: false },
        task_results: [],
        provider_pinned: "zai",
      }),
      { params: Promise.resolve({ id: "run-pinned" }) },
    );

    expect(response.status).toBe(200);
    expect((await storageRef.current.getRun("run-pinned"))?.provider_pinned).toBe("zai");
  });

  it("does not let a terminal callback from a historical run overwrite the current replay submission", async () => {
    await storageRef.current.putRun({
      id: "old-run",
      submission_id: "sub-replay",
      status: "running",
      task_results: [],
      created_at: "2026-07-21T00:00:00.000Z",
    });
    await storageRef.current.putSubmission({
      id: "sub-replay",
      agent_name: "agent",
      prompt: "p",
      status: "running",
      run_id: "new-run",
      run_ids: ["old-run", "new-run"],
      created_at: "2026-07-21T00:00:00.000Z",
    });

    const response = await POST(
      callbackRequest("old-run", { events: [], status: "failed" }),
      { params: Promise.resolve({ id: "old-run" }) },
    );
    expect(response.status).toBe(200);
    expect((await storageRef.current.getSubmission("sub-replay"))?.status).toBe("running");
  });

  // A baseline runs vanilla, so its submitted prompt is empty by design. The
  // prompt pi actually used is its own default, built inside the container --
  // captured off the wire rather than reconstructed, so it must round-trip.
  it("records the system prompt pi actually resolved to", async () => {
    await storageRef.current.putRun({
      id: "run-prompt",
      submission_id: "sub-1",
      status: "running",
      task_results: [],
      created_at: "2026-07-21T00:00:00.000Z",
    });

    const response = await POST(
      callbackRequest("run-prompt", {
        events: [],
        status: "completed",
        totals: { tasks_passed: 3, total_cost_usd: 1, over_budget: false },
        task_results: [],
        resolved_system_prompt: "You are an expert coding assistant operating inside pi",
      }),
      { params: Promise.resolve({ id: "run-prompt" }) },
    );

    expect(response.status).toBe(200);
    expect((await storageRef.current.getRun("run-prompt"))?.resolved_system_prompt).toBe(
      "You are an expert coding assistant operating inside pi",
    );
  });
});
