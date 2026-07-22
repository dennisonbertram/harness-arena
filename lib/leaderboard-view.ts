import { sortLeaderboard } from "./leaderboard";
import type { Storage } from "./storage";

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
