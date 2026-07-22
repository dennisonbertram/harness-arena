import type { Run } from "./types";

// Leaderboard = completed runs only (Run.status has no "scored" value;
// "completed" is the equivalent — the run has tasks_passed/total_cost_usd
// set). Ranked by tasks_passed desc, then total_cost_usd asc (cheaper wins
// ties). Acceptable to list-and-sort at POC scale per ticket #4.
export function sortLeaderboard(runs: Run[]): Run[] {
  return runs
    .filter((run) => run.status === "completed")
    .sort((a, b) => {
      const passedDiff = (b.tasks_passed ?? 0) - (a.tasks_passed ?? 0);
      if (passedDiff !== 0) return passedDiff;
      return (a.total_cost_usd ?? 0) - (b.total_cost_usd ?? 0);
    });
}
