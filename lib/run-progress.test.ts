import { describe, expect, it } from "vitest";
import { reconstructRunProgress } from "./run-progress";
import type { RunEvent } from "./types";

let seq = 0;
function ev(type: string, payload: Record<string, unknown>): RunEvent {
  seq += 1;
  return { seq, run_id: "r", ts: "2026-07-23T00:00:00.000Z", type, payload } as RunEvent;
}

describe("reconstructRunProgress", () => {
  it("tracks each task's state through the started → agent_finished → verified lifecycle", () => {
    seq = 0;
    const events = [
      ev("task.started", { task_id: "t0", index: 0 }),
      ev("task.agent_finished", { task_id: "t0", turns: 5, cost_usd: 0.02, duration_s: 30 }),
      ev("task.verified", { task_id: "t0", passed: true, reward: 1 }),
      ev("task.trace_uploaded", { task_id: "t0", blob_url: "x" }),
      ev("task.started", { task_id: "t1", index: 1 }),
      ev("task.agent_finished", { task_id: "t1", turns: 3, cost_usd: 0.01 }),
      ev("task.verified", { task_id: "t1", passed: false, reward: 0 }),
      ev("task.started", { task_id: "t2", index: 2 }), // in progress, not verified
    ];
    const p = reconstructRunProgress(events);
    expect(p.tasks.map((t) => [t.taskId, t.state])).toEqual([
      ["t0", "passed"],
      ["t1", "failed"],
      ["t2", "running"],
    ]);
    expect(p.started).toBe(3);
    expect(p.verified).toBe(2);
    expect(p.passed).toBe(1);
    expect(p.costSoFar).toBeCloseTo(0.03);
    expect(p.current).toBe("t2");
    expect(p.tasks[0]).toMatchObject({ turns: 5, costUsd: 0.02, hasTrace: true });
  });

  it("marks a task 'verifying' after the agent finishes but before verification", () => {
    seq = 0;
    const events = [
      ev("task.started", { task_id: "t0", index: 0 }),
      ev("task.agent_finished", { task_id: "t0", turns: 4 }),
      ev("task.verify_started", { task_id: "t0" }),
    ];
    const p = reconstructRunProgress(events);
    expect(p.tasks[0].state).toBe("verifying");
    expect(p.current).toBe("t0");
  });

  it("reports null costSoFar when no task carried a measured cost (unmeasured / 0-turn)", () => {
    seq = 0;
    const events = [
      ev("task.started", { task_id: "t0", index: 0 }),
      ev("task.agent_finished", { task_id: "t0", turns: 0 }), // no cost_usd = unmeasured
      ev("task.verified", { task_id: "t0", passed: false }),
    ];
    expect(reconstructRunProgress(events).costSoFar).toBeNull();
  });

  it("orders tasks by index even if events arrive out of order", () => {
    seq = 0;
    const events = [ev("task.started", { task_id: "b", index: 1 }), ev("task.started", { task_id: "a", index: 0 })];
    // stamp a lower seq on the later event to prove index (not seq) orders output
    events[1].seq = 99;
    expect(reconstructRunProgress(events).tasks.map((t) => t.taskId)).toEqual(["a", "b"]);
  });
});
