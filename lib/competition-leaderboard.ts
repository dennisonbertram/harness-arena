import type { Storage } from "./storage";
import type { Run, Submission } from "./types";

export interface CompetitionRow {
  submissionId: string;
  runId: string;
  rank: number;
  tied: boolean;
  tasksPassed: number;
  totalTasks: number;
  totalCostUsd: number;
  submittedAt: string;
  // The entrant's GitHub login (already-public GitHub data) — the leaderboard
  // identity axis now that submissions require sign-in. Falls back to
  // "unknown" for a pre-login stray blob; never applies to the baseline row
  // (it has no submitting user and isn't rendered from a CompetitionRow).
  githubLogin: string;
}

export type BaselineState = "none" | "running" | "rejected" | "ready";

export interface CompetitionBoard {
  baseline: CompetitionRow | null;
  baselineState: BaselineState;
  baselineRejectionReason?: string;
  ranked: CompetitionRow[];
  pending: number;
}

interface JoinedEntry {
  submission: Submission;
  run: Run | undefined;
}

function joinCompetitionEntries(runs: Run[], submissions: Submission[]): JoinedEntry[] {
  const runById = new Map(runs.map((r) => [r.id, r]));
  return submissions
    .filter((s) => s.competition === true)
    .map((submission) => ({
      submission,
      run: submission.run_id ? runById.get(submission.run_id) : undefined,
    }));
}

function toRow(entry: JoinedEntry): CompetitionRow | null {
  const { submission, run } = entry;
  if (!run || run.status !== "completed" || run.tasks_passed === undefined || run.total_cost_usd === undefined) {
    return null;
  }
  return {
    submissionId: submission.id,
    runId: run.id,
    rank: 0, // assigned by rankCompetition
    tied: false,
    tasksPassed: run.tasks_passed,
    totalTasks: run.task_results.length,
    totalCostUsd: run.total_cost_usd,
    submittedAt: submission.created_at,
    githubLogin: submission.github_login ?? "unknown",
  };
}

/**
 * Ranks by tasks solved descending, total cost ascending as tiebreak. Rows
 * sharing an identical (tasksPassed, totalCostUsd) pair share a rank and are
 * both marked `tied` — the app surfaces "Tied for #N" rather than splitting
 * them into consecutive ranks. Real-world prize splitting for ties is a
 * manual, out-of-band admin decision; this module only marks the tie.
 */
export function rankCompetition(rows: CompetitionRow[]): CompetitionRow[] {
  const sorted = [...rows].sort((a, b) => b.tasksPassed - a.tasksPassed || a.totalCostUsd - b.totalCostUsd);

  const withRank: CompetitionRow[] = [];
  let rank = 0;
  for (let i = 0; i < sorted.length; i++) {
    const prev = withRank[i - 1];
    const sameAsPrev =
      prev !== undefined && prev.tasksPassed === sorted[i].tasksPassed && prev.totalCostUsd === sorted[i].totalCostUsd;
    if (!sameAsPrev) rank = i + 1;
    withRank.push({ ...sorted[i], rank });
  }

  const countByRank = new Map<number, number>();
  for (const r of withRank) countByRank.set(r.rank, (countByRank.get(r.rank) ?? 0) + 1);
  return withRank.map((r) => ({ ...r, tied: (countByRank.get(r.rank) ?? 0) > 1 }));
}

/**
 * The full /competition board: the baseline (in one of four states — see
 * BaselineState) split out from the ranked competitor table, plus a pending
 * count for competitor runs still queued/running.
 */
export async function getCompetitionBoard(storage: Storage): Promise<CompetitionBoard> {
  const [runs, submissions] = await Promise.all([storage.listRuns(), storage.listSubmissions()]);
  const entries = joinCompetitionEntries(runs, submissions);

  const baselineEntry = entries.find((e) => e.submission.competition_baseline === true);
  let baseline: CompetitionRow | null = null;
  let baselineState: BaselineState = "none";
  let baselineRejectionReason: string | undefined;
  if (baselineEntry) {
    if (baselineEntry.submission.status === "rejected") {
      baselineState = "rejected";
      baselineRejectionReason = baselineEntry.submission.judge_reason;
    } else {
      const row = toRow(baselineEntry);
      if (row) {
        baseline = row;
        baselineState = "ready";
      } else {
        baselineState = "running";
      }
    }
  }

  const competitorEntries = entries.filter((e) => e.submission.competition_baseline !== true);
  const rows = competitorEntries.map(toRow).filter((r): r is CompetitionRow => r !== null);
  const ranked = rankCompetition(rows);

  const pending = competitorEntries.filter(
    (e) => e.run !== undefined && (e.run.status === "queued" || e.run.status === "running"),
  ).length;

  return { baseline, baselineState, baselineRejectionReason, ranked, pending };
}
