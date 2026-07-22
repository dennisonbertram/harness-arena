import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
        task_results: [{ task_id: "t1", attempted: true, passed: true, cost_usd: 0.1 }],
        totals: { tasks_passed: 1, total_cost_usd: 0.1, over_budget: false },
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
    expect(run?.task_results).toEqual([{ task_id: "t1", attempted: true, passed: true, cost_usd: 0.1 }]);
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
  });
});
