import { ARENA_HARNESS } from "./arena-params";
import { COMPETITION_MODEL } from "./competition-config";
import type { Storage } from "./storage";
import type { Competition, Run, Submission } from "./types";
import { UNKNOWN_GITHUB_LOGIN } from "./github";

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

// The Competition entity backing the (arena=harness-arena, harness=pi,
// model=COMPETITION_MODEL) seeded row -- id is DERIVED from that triple, the
// same way scripts/seed-competition.mjs's competitionId() computes it, so
// this always agrees with what the backfill script created. Duplicated here
// (rather than importing the .mjs script) because that script imports
// @vercel/blob at module scope, which has no business loading into the
// leaderboard's read path.
const LEGACY_ARENA = "harness-arena";
export function defaultCompetitionId(): string {
  return ["comp", LEGACY_ARENA, ARENA_HARNESS, COMPETITION_MODEL]
    .join("__")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolves "the live default" competition for callers (the homepage) that
 * don't yet let a user pick one (that's #78's switcher). Prefers the seeded
 * Harness Arena / Pi / COMPETITION_MODEL row by its deterministic id; falls
 * back to the most-recently-created live competition if that id isn't found
 * (e.g. COMPETITION_MODEL reconfigured after seeding) so a misconfiguration
 * shows *a* live board rather than none.
 */
export async function resolveDefaultCompetition(storage: Storage): Promise<Competition | undefined> {
  const byDefaultId = await storage.getCompetition(defaultCompetitionId());
  // Only take the seeded row if it's still live. Closing is MANUAL (#74), so
  // a closed default is an expected state, not an edge case -- returning it
  // anyway would render a finished contest as the active one, submission
  // form and all, while a genuinely live competition sits unshown.
  if (byDefaultId?.status === "live") return byDefaultId;
  const all = await storage.listCompetitions();
  return all.find((c) => c.status === "live") ?? byDefaultId;
}

/**
 * A submission belongs to `competitionId` if it's explicitly stamped
 * (competition_id matches), OR it's a legacy row -- `competition: true` with
 * no competition_id, predating the Competition entity -- and `competitionId`
 * is the seeded default those legacy rows implicitly belong to. The backfill
 * script (issue #75) should have stamped every such row, but this read path
 * must stay correct even if one was missed or a new one lands before the
 * write path (#77) is in.
 */
export function belongsToCompetition(submission: Submission, competitionId: string, defaultId: string): boolean {
  if (submission.competition !== true) return false;
  if (submission.competition_id) return submission.competition_id === competitionId;
  return competitionId === defaultId;
}

function joinCompetitionEntries(
  runs: Run[],
  submissions: Submission[],
  competitionId: string,
  defaultId: string,
): JoinedEntry[] {
  const runById = new Map(runs.map((r) => [r.id, r]));
  return submissions
    .filter((s) => belongsToCompetition(s, competitionId, defaultId))
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
    githubLogin: submission.github_login ?? UNKNOWN_GITHUB_LOGIN,
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
 * The full /competition board for ONE competition: the baseline (in one of
 * four states — see BaselineState) split out from the ranked competitor
 * table, plus a pending count for competitor runs still queued/running.
 * Scoped to `competitionId` -- see belongsToCompetition for the legacy
 * (un-backfilled) row fallback.
 */
export async function getCompetitionBoard(storage: Storage, competitionId: string): Promise<CompetitionBoard> {
  const [runs, submissions, legacyOwner] = await Promise.all([
    storage.listRuns(),
    storage.listSubmissions(),
    // Which competition owns unstamped legacy rows must be the SAME one the
    // homepage resolves. Re-deriving the id from COMPETITION_MODEL here would
    // disagree with resolveDefaultCompetition the moment that env var changes
    // after seeding -- and every legacy row would silently drop off the board.
    resolveDefaultCompetition(storage),
  ]);
  const entries = joinCompetitionEntries(runs, submissions, competitionId, legacyOwner?.id ?? defaultCompetitionId());

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
