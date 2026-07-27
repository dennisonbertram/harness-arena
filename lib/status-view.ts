import type { Run, RunEvent, Submission } from "./types";
import { UNKNOWN_GITHUB_LOGIN } from "./github";

// $25 total POC inference cap and $2 per-run hard cap — the same figures
// ticket #8's proof-run budget enforcement uses. Defined once here (this
// ticket only displays them) so a future shared config move has a single
// call site to update, per the ticket's own regression-risk note about the
// $25 figure drifting between two hardcoded places.
export const POC_BUDGET_CAP_USD = 25;
export const PER_RUN_BUDGET_CAP_USD = 2;

/**
 * Counts items with a `status` field into a record with an entry for every
 * status in `allStatuses`, zeroed by default, so a status with zero
 * occurrences still shows up as 0 in the UI rather than being absent.
 */
export function countByStatus<T extends string>(
  items: readonly { status: T }[],
  allStatuses: readonly T[],
): Record<T, number> {
  const counts = Object.fromEntries(allStatuses.map((status) => [status, 0])) as Record<T, number>;
  for (const item of items) {
    counts[item.status] += 1;
  }
  return counts;
}

export interface RecentActivityRow {
  runId: string;
  agentName: string;
  githubLogin: string;
  status: Run["status"];
  tasksPassed: number | undefined;
  totalTasks: number;
  totalCostUsd: number | undefined;
  lastEventType: RunEvent["type"] | undefined;
  lastEventAt: string | undefined;
}

const RECENT_ACTIVITY_LIMIT = 15;

/**
 * Builds "recent activity" rows for the status page: the given runs (any
 * status), each joined with its submitting agent's name and its most recent
 * event (highest seq). A run referencing a submission that no longer exists
 * falls back to "unknown" rather than throwing (same convention as
 * getLeaderboardView). Assumes `runs` is already sorted newest-first
 * (storage.listRuns()'s documented contract) and only slices to `limit`
 * rather than re-sorting.
 */
export function recentActivity(
  runs: readonly Run[],
  submissions: readonly Submission[],
  eventsByRun: ReadonlyMap<string, readonly RunEvent[]>,
  limit: number = RECENT_ACTIVITY_LIMIT,
): RecentActivityRow[] {
  const submissionById = new Map(submissions.map((submission) => [submission.id, submission]));

  return runs.slice(0, limit).map((run) => {
    const submission = submissionById.get(run.submission_id);
    const events = eventsByRun.get(run.id) ?? [];
    const lastEvent = events.reduce<RunEvent | undefined>(
      (latest, event) => (!latest || event.seq > latest.seq ? event : latest),
      undefined,
    );

    return {
      runId: run.id,
      agentName: submission?.agent_name ?? "unknown",
      githubLogin: submission?.github_login ?? UNKNOWN_GITHUB_LOGIN,
      status: run.status,
      tasksPassed: run.tasks_passed,
      totalTasks: run.task_results.length,
      totalCostUsd: run.total_cost_usd,
      lastEventType: lastEvent?.type,
      lastEventAt: lastEvent?.ts,
    };
  });
}

/**
 * Sums total_cost_usd across every run that has recorded one. Not filtered
 * to "completed" runs only — a failed or over-budget run can still have
 * incurred (and recorded) real spend, and the point of this total is actual
 * money spent against the $25 POC cap, not just spend on successful runs.
 */
export function totalSpendUsd(runs: readonly Run[]): number {
  return runs.reduce((sum, run) => sum + (run.total_cost_usd ?? 0), 0);
}
