import { describe, expect, it } from "vitest";
import { sortLeaderboard } from "./leaderboard";
import type { Run } from "./types";

function run(id: string, status: Run["status"], tasksPassed?: number, costUsd?: number): Run {
  return {
    id,
    submission_id: "sub-1",
    status,
    tasks_passed: tasksPassed,
    total_cost_usd: costUsd,
    task_results: [],
    created_at: "2026-07-21T00:00:00.000Z",
  };
}

describe("sortLeaderboard", () => {
  it("orders completed runs by tasks_passed descending, then total_cost_usd ascending", () => {
    const runs = [
      run("a", "completed", 5, 2.0),
      run("b", "completed", 7, 3.0),
      run("c", "completed", 7, 1.0),
    ];

    const result = sortLeaderboard(runs);

    expect(result.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("excludes runs that are not yet scored (only status completed counts)", () => {
    const runs = [
      run("done", "completed", 3, 1.0),
      run("pending", "queued"),
      run("crashed", "failed"),
      run("gone", "reaped"),
      run("active", "running"),
    ];

    const result = sortLeaderboard(runs);

    expect(result.map((r) => r.id)).toEqual(["done"]);
  });

  it("excludes a completed run missing tasks_passed instead of ranking it as zero", () => {
    const runs = [
      run("scored", "completed", 3, 1.0),
      run("incomplete-data", "completed", undefined, 1.0),
    ];

    const result = sortLeaderboard(runs);

    expect(result.map((r) => r.id)).toEqual(["scored"]);
  });

  it("excludes a completed run missing total_cost_usd instead of ranking it as zero", () => {
    const runs = [
      run("scored", "completed", 3, 1.0),
      run("incomplete-data", "completed", 3, undefined),
    ];

    const result = sortLeaderboard(runs);

    expect(result.map((r) => r.id)).toEqual(["scored"]);
  });

  describe("regression: missing data vs. a genuine zero score", () => {
    it("includes a completed run with tasks_passed=0 (a real zero, not missing data)", () => {
      // A naive fix (e.g. `if (!run.tasks_passed) return false`) would treat
      // 0 as falsy and wrongly exclude a run that legitimately passed zero
      // tasks. Only `undefined` means "missing", not `0`.
      const runs = [run("zero-score", "completed", 0, 5.0), run("higher-score", "completed", 2, 5.0)];

      const result = sortLeaderboard(runs);

      expect(result.map((r) => r.id)).toEqual(["higher-score", "zero-score"]);
    });
  });
});
