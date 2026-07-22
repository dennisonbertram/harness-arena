import type { Run } from "./types";

// Leaderboard = completed runs only (Run.status has no "scored" value;
// "completed" is the equivalent — the run has tasks_passed/total_cost_usd
// set). Ranked by tasks_passed desc, then total_cost_usd asc (cheaper wins
// ties). Acceptable to list-and-sort at POC scale per ticket #4.
// A "completed" run missing tasks_passed or total_cost_usd is incomplete
// data (scoring didn't finish writing the run), not a legitimate zero score
// — it is excluded rather than ranked.
export function sortLeaderboard(runs: Run[]): Run[] {
  return runs
    .filter((run) => run.status === "completed" && run.tasks_passed !== undefined && run.total_cost_usd !== undefined)
    .sort((a, b) => {
      const passedDiff = b.tasks_passed! - a.tasks_passed!;
      if (passedDiff !== 0) return passedDiff;
      return a.total_cost_usd! - b.total_cost_usd!;
    });
}
