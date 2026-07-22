import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./storage";
import type { Run, Submission } from "./types";

function makeRun(id: string, createdAt: string): Run {
  return {
    id,
    submission_id: "sub-1",
    status: "queued",
    task_results: [],
    created_at: createdAt,
  };
}

describe("MemoryStorage", () => {
  it("round-trips a Submission with every field intact", async () => {
    const storage = new MemoryStorage();
    const submission: Submission = {
      id: "sub-1",
      agent_name: "agent-x",
      prompt: "do the thing",
      status: "pending_review",
      judge_verdict: "approve",
      judge_reason: "looks good",
      judge_model: "gpt-5",
      judged_at: "2026-07-21T00:00:00.000Z",
      run_id: "run-1",
      created_at: "2026-07-20T00:00:00.000Z",
    };

    await storage.putSubmission(submission);
    const result = await storage.getSubmission("sub-1");

    expect(result).toEqual(submission);
  });

  it("round-trips a Run with every field intact, including nested task_results", async () => {
    const storage = new MemoryStorage();
    const run: Run = {
      id: "run-1",
      submission_id: "sub-1",
      status: "completed",
      started_at: "2026-07-21T00:00:00.000Z",
      finished_at: "2026-07-21T00:05:00.000Z",
      tasks_passed: 7,
      total_cost_usd: 1.23,
      over_budget: false,
      sandbox_id: "sandbox-1",
      task_results: [
        {
          task_id: "t1",
          attempted: true,
          passed: true,
          reward: 1,
          cost_usd: 0.1,
          duration_s: 12,
          turns: 3,
          trace_blob_url: "https://blob.example/t1.jsonl",
        },
      ],
      created_at: "2026-07-21T00:00:00.000Z",
    };

    await storage.putRun(run);
    const result = await storage.getRun("run-1");

    expect(result).toEqual(run);
  });

  it("listRuns returns runs ordered by created_at descending, regardless of insertion order", async () => {
    const storage = new MemoryStorage();
    const older = makeRun("run-old", "2026-07-01T00:00:00.000Z");
    const newer = makeRun("run-new", "2026-07-10T00:00:00.000Z");

    await storage.putRun(older);
    await storage.putRun(newer);

    const runs = await storage.listRuns();

    expect(runs.map((r) => r.id)).toEqual(["run-new", "run-old"]);
  });

  it("appendRunEvents assigns monotonic seq 1..n across two separate batches", async () => {
    const storage = new MemoryStorage();
    const runId = "run-1";

    const firstBatch = await storage.appendRunEvents(runId, [
      { ts: "2026-07-21T00:00:00.000Z", type: "run.created", payload: { submission_id: "sub-1" } },
      { ts: "2026-07-21T00:00:01.000Z", type: "run.sandbox_creating", payload: {} },
    ]);

    const secondBatch = await storage.appendRunEvents(runId, [
      { ts: "2026-07-21T00:00:02.000Z", type: "run.sandbox_ready", payload: { sandbox_id: "sb-1" } },
    ]);

    expect(firstBatch.map((e) => e.seq)).toEqual([1, 2]);
    expect(secondBatch.map((e) => e.seq)).toEqual([3]);
  });

  it("listRunEvents returns events in strict seq order", async () => {
    const storage = new MemoryStorage();
    const runId = "run-1";

    await storage.appendRunEvents(runId, [
      { ts: "2026-07-21T00:00:00.000Z", type: "run.created", payload: { submission_id: "sub-1" } },
    ]);
    await storage.appendRunEvents(runId, [
      {
        ts: "2026-07-21T00:00:01.000Z",
        type: "run.completed",
        payload: { tasks_passed: 1, total_cost_usd: 0.5, duration_s: 60 },
      },
    ]);

    const events = await storage.listRunEvents(runId);

    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.map((e) => e.type)).toEqual(["run.created", "run.completed"]);
  });

  it("listSubmissions returns an empty array when nothing has been stored", async () => {
    const storage = new MemoryStorage();
    expect(await storage.listSubmissions()).toEqual([]);
  });
});
