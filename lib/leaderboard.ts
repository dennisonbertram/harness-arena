import type { Run, Submission } from "./types";
import { normalizeBenchmark, type BenchmarkBoard } from "./arena-params";

// The competition is binary: a run is RANKED only if it completed the entire
// test — passed every task in the benchmark. Passing some-but-not-all is not a
// partial score, it's a failed run (shown for transparency, but unranked).
// Among runs that complete the whole test, the single ranking axis is total
// cost, ascending — the cheapest complete solution wins.
//
// If nothing completes the test, the ranked board is legitimately empty: the
// finding is "no price completes this task set on this model+harness yet."
//
// `totalTaskCount` is the number of tasks in the current benchmark. A run must
// carry a result for every one of them (not just pass the ones it happened to
// run) — so a run reaped mid-way with 15/16 all-passing results does NOT count
// as completing a 16-task test.
export function isComplete(run: Run, totalTaskCount: number): boolean {
  if (run.status !== "completed" || run.total_cost_usd === undefined) return false;
  if (run.task_results.length !== totalTaskCount) return false;
  return run.task_results.every((t) => t.passed);
}

/**
 * Board discrimination. Both boards live in one storage keyed by run ->
 * submission; the board is read off the submission's `benchmark` field
 * (absent = "terminal-bench-2" — every legacy row predates multiple boards).
 * A run whose submission no longer exists is treated as a legacy
 * terminal-bench row, matching how every other join falls back for orphans.
 */
export function runsForBoard(
  runs: readonly Run[],
  submissions: readonly Submission[],
  benchmark: BenchmarkBoard,
): Run[] {
  const submissionById = new Map(submissions.map((submission) => [submission.id, submission]));
  return runs.filter((run) => normalizeBenchmark(submissionById.get(run.submission_id)?.benchmark) === benchmark);
}

/** The ranked board: complete runs only, ordered by total cost ascending. */
export function sortLeaderboard(runs: Run[], totalTaskCount: number): Run[] {
  return runs
    .filter((run) => isComplete(run, totalTaskCount))
    .sort((a, b) => a.total_cost_usd! - b.total_cost_usd!);
}

/**
 * Splits completed runs into the ranked board (complete tests, cost asc) and
 * everything else (incomplete — ran but didn't pass every task). Incomplete
 * runs are ordered by tasks_passed desc purely for readability; that ordering
 * is not a score.
 */
export function partitionLeaderboard(
  runs: Run[],
  totalTaskCount: number,
): { ranked: Run[]; incomplete: Run[] } {
  const ranked = sortLeaderboard(runs, totalTaskCount);
  const rankedIds = new Set(ranked.map((r) => r.id));
  const incomplete = runs
    .filter(
      (r) => r.status === "completed" && r.total_cost_usd !== undefined && !rankedIds.has(r.id),
    )
    .sort((a, b) => (b.tasks_passed ?? 0) - (a.tasks_passed ?? 0) || a.total_cost_usd! - b.total_cost_usd!);
  return { ranked, incomplete };
}
