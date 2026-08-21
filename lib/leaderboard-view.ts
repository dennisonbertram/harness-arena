import { aggregatePrompts, type PromptStanding } from "./aggregate";
import { partitionLeaderboard, runsForBoard } from "./leaderboard";
import { getTasks } from "./tasks";
import { DEFAULT_BENCHMARK, type BenchmarkBoard } from "./arena-params";
import type { Storage } from "./storage";
import type { Run, Submission } from "./types";

/**
 * v1 standings: every prompt's mean pass rate across its runs, ranked pass
 * rate desc (cost breaks ties). This is the primary board — cost ranking
 * waits until pass rate is saturated. `benchmark` selects the board; the
 * default is the legacy terminal-bench board, so existing callers are
 * unaffected.
 */
export async function getStandings(
  storage: Storage,
  benchmark: BenchmarkBoard = DEFAULT_BENCHMARK,
): Promise<PromptStanding[]> {
  const [runs, submissions] = await Promise.all([storage.listRuns(), storage.listSubmissions()]);
  const boardRuns = runsForBoard(runs, submissions, benchmark);
  return aggregatePrompts(boardRuns, submissions, getTasks().length);
}

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

/** Joins runs to their submitting agent's name; rank is the array index+1.
 *  A run whose submission no longer exists falls back to "unknown". */
function rowsFor(runs: Run[], submissionById: Map<string, Submission>): LeaderboardRow[] {
  return runs.map((run, index) => {
    const submission = submissionById.get(run.submission_id);
    const totalTasks = run.task_results.length;
    const totalCostUsd = run.total_cost_usd!;
    return {
      rank: index + 1,
      runId: run.id,
      agentName: submission?.agent_name ?? "unknown",
      tasksPassed: run.tasks_passed!,
      totalTasks,
      costPerTaskUsd: totalTasks > 0 ? totalCostUsd / totalTasks : totalCostUsd,
      totalCostUsd,
      submittedAt: submission?.created_at ?? run.created_at,
    };
  });
}

/**
 * The two leaderboard sections:
 *  - ranked: runs that completed the whole test (passed every task), ordered by
 *    the single optimization parameter (total cost, ascending).
 *  - incomplete: completed runs that didn't pass every task — shown for
 *    transparency but not ranked (they didn't finish the test).
 *
 * `benchmark` selects the board (default: the legacy terminal-bench board);
 * runs belonging to the other board are excluded, never mixed in.
 */
export async function getLeaderboardSections(
  storage: Storage,
  benchmark: BenchmarkBoard = DEFAULT_BENCHMARK,
): Promise<{ ranked: LeaderboardRow[]; incomplete: LeaderboardRow[] }> {
  const [runs, submissions] = await Promise.all([storage.listRuns(), storage.listSubmissions()]);
  const submissionById = new Map(submissions.map((submission) => [submission.id, submission]));
  const boardRuns = runsForBoard(runs, submissions, benchmark);
  const { ranked, incomplete } = partitionLeaderboard(boardRuns, getTasks().length);
  return { ranked: rowsFor(ranked, submissionById), incomplete: rowsFor(incomplete, submissionById) };
}

/** Backwards-compatible view: the ranked (complete-test) rows only. */
export async function getLeaderboardView(
  storage: Storage,
  benchmark: BenchmarkBoard = DEFAULT_BENCHMARK,
): Promise<LeaderboardRow[]> {
  return (await getLeaderboardSections(storage, benchmark)).ranked;
}
