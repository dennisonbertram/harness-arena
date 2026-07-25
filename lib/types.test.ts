import { describe, expect, it } from "vitest";
import { RunEventSchema, RunSchema } from "./types";

describe("RunSchema timestamp validation", () => {
  it("rejects created_at that is not a valid ISO datetime string", () => {
    const result = RunSchema.safeParse({
      id: "run-1",
      submission_id: "sub-1",
      status: "queued",
      task_results: [],
      created_at: "not-a-date",
    });

    expect(result.success).toBe(false);
  });

  it("accepts a valid ISO datetime string for created_at", () => {
    const result = RunSchema.safeParse({
      id: "run-1",
      submission_id: "sub-1",
      status: "queued",
      task_results: [],
      created_at: "2026-07-21T00:00:00.000Z",
    });

    expect(result.success).toBe(true);
  });
});

describe("RUN_EVENT_TYPES: task.cost_tamper_signal (runner-emitted, issue #24)", () => {
  it("accepts a task.cost_tamper_signal event as a valid RunEvent", () => {
    const result = RunEventSchema.safeParse({
      run_id: "run-1",
      seq: 1,
      ts: "2026-07-21T00:00:00.000Z",
      type: "task.cost_tamper_signal",
      payload: { task_id: "t1", reason: "cost_unmeasured" },
    });

    expect(result.success).toBe(true);
  });
});
