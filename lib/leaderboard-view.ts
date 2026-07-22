import { sortLeaderboard } from "./leaderboard";
import type { Storage } from "./storage";

/** The reference entry: stock pi harness prompt, nothing added. Shown as the
 *  baseline to beat, above the competitive leaderboard. */
export const BASELINE_AGENT_NAME = "pi-vanilla-baseline";

export interface LeaderboardRow {
  rank: number;
  runId: string;
  agentName: string;
  tasksPassed: number;
  totalTasks: number;
  costPerTaskUsd: number;
  totalCostUsd: number;
  submittedAt: string;
}

/**
 * Splits the baseline (stock pi harness) out of the ranked list so it can be
 * featured as a reference above the leaderboard. The baseline is the
 * best-ranked run named BASELINE_AGENT_NAME (rows arrive in rank order);
 * competitors are everything else, re-ranked 1..n. If several baseline runs
 * exist, only the top one is featured — the rest stay in the competitor list.
 */
export function partitionBaseline(rows: LeaderboardRow[]): {
  baseline: LeaderboardRow | null;
  competitors: LeaderboardRow[];
} {
  const baselineIndex = rows.findIndex((row) => row.agentName === BASELINE_AGENT_NAME);
  const baseline = baselineIndex === -1 ? null : rows[baselineIndex];
  const competitors = rows
    .filter((_, i) => i !== baselineIndex)
    .map((row, i) => ({ ...row, rank: i + 1 }));
  return { baseline, competitors };
}

/**
 * Assembles leaderboard rows by joining completed runs (via sortLeaderboard,
 * so ranking stays identical to the API's) with their submitting agent's
 * name. A run referencing a submission that no longer exists in storage
 * falls back to "unknown" rather than throwing.
 */
export async function getLeaderboardView(storage: Storage): Promise<LeaderboardRow[]> {
  const [runs, submissions] = await Promise.all([storage.listRuns(), storage.listSubmissions()]);
  const submissionById = new Map(submissions.map((submission) => [submission.id, submission]));

  return sortLeaderboard(runs).map((run, index) => {
    const submission = submissionById.get(run.submission_id);
    const tasksPassed = run.tasks_passed!;
    const totalCostUsd = run.total_cost_usd!;
    const totalTasks = run.task_results.length;

    return {
      rank: index + 1,
      runId: run.id,
      agentName: submission?.agent_name ?? "unknown",
      tasksPassed,
      totalTasks,
      costPerTaskUsd: totalTasks > 0 ? totalCostUsd / totalTasks : totalCostUsd,
      totalCostUsd,
      submittedAt: submission?.created_at ?? run.created_at,
    };
  });
}
