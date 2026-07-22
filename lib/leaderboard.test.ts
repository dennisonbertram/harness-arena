import { describe, expect, it } from "vitest";
import { isComplete, partitionLeaderboard, sortLeaderboard } from "./leaderboard";
import type { Run, TaskResult } from "./types";

const TOTAL = 3; // the test has 3 tasks in these fixtures

function tr(task_id: string, passed: boolean): TaskResult {
  return { task_id, attempted: true, passed };
}

// Builds a run with `passCount` of `TOTAL` tasks passed (the rest failed).
function run(id: string, status: Run["status"], passCount: number, costUsd?: number, taskCount = TOTAL): Run {
  const results: TaskResult[] = [];
  for (let i = 0; i < taskCount; i++) results.push(tr(`t${i}`, i < passCount));
  return {
    id,
    submission_id: "sub-1",
    status,
    tasks_passed: status === "completed" ? passCount : undefined,
    total_cost_usd: costUsd,
    task_results: results,
    created_at: "2026-07-21T00:00:00.000Z",
  };
}

describe("isComplete", () => {
  it("is true only when every task in the test passed", () => {
    expect(isComplete(run("a", "completed", TOTAL, 1.0), TOTAL)).toBe(true);
  });

  it("is false when one task failed (partial is not complete)", () => {
    expect(isComplete(run("a", "completed", TOTAL - 1, 1.0), TOTAL)).toBe(false);
  });

  it("is false when the run didn't cover the whole test, even if all its results passed", () => {
    // 2 results, both passing, but the test has 3 tasks -> not complete.
    const partial = run("a", "completed", 2, 1.0, 2);
    expect(isComplete(partial, TOTAL)).toBe(false);
  });

  it("is false for non-completed runs", () => {
    expect(isComplete(run("a", "running", TOTAL, 1.0), TOTAL)).toBe(false);
  });

  it("is false when total_cost_usd is missing (incomplete scoring data)", () => {
    expect(isComplete(run("a", "completed", TOTAL, undefined), TOTAL)).toBe(false);
  });
});

describe("sortLeaderboard", () => {
  it("ranks only complete runs, by total cost ascending — the single parameter", () => {
    const runs = [
      run("pricey", "completed", TOTAL, 3.0),
      run("cheap", "completed", TOTAL, 1.0),
      run("mid", "completed", TOTAL, 2.0),
    ];
    expect(sortLeaderboard(runs, TOTAL).map((r) => r.id)).toEqual(["cheap", "mid", "pricey"]);
  });

  it("excludes every run that didn't complete the test, however cheap", () => {
    const runs = [
      run("almost", "completed", TOTAL - 1, 0.1), // one task short, dirt cheap
      run("complete", "completed", TOTAL, 1.0),
    ];
    expect(sortLeaderboard(runs, TOTAL).map((r) => r.id)).toEqual(["complete"]);
  });

  it("is empty when nothing completes the test", () => {
    const runs = [run("a", "completed", 1, 0.2), run("b", "completed", 2, 0.3)];
    expect(sortLeaderboard(runs, TOTAL)).toEqual([]);
  });
});

describe("partitionLeaderboard", () => {
  it("splits complete runs (cost asc) from incomplete ones (passes desc, unranked)", () => {
    const runs = [
      run("c-dear", "completed", TOTAL, 2.0),
      run("c-cheap", "completed", TOTAL, 1.0),
      run("inc-2", "completed", 2, 0.5),
      run("inc-1", "completed", 1, 0.2),
    ];
    const { ranked, incomplete } = partitionLeaderboard(runs, TOTAL);
    expect(ranked.map((r) => r.id)).toEqual(["c-cheap", "c-dear"]);
    expect(incomplete.map((r) => r.id)).toEqual(["inc-2", "inc-1"]);
  });
});
