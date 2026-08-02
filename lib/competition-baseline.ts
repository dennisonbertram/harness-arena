import { randomUUID } from "node:crypto";
import { getBaselinePrompt } from "@/lib/baseline-prompt";
import { isInfraFailedRun, judgeAndDispatch } from "@/lib/competition-dispatch";
import { belongsToCompetition, resolveLegacyOwnerId } from "@/lib/competition-leaderboard";
import { log, normalizeError } from "@/lib/log";
import type { Storage } from "@/lib/storage";
import type { Competition, Run, Submission } from "@/lib/types";

export const BASELINE_AGENT_NAME = "pi-vanilla-baseline";

/**
 * How long an unjudged baseline is treated as still in flight. Judging is one
 * LLM round-trip, so a minute is generous; past this it is presumed dead.
 */
export const PENDING_BASELINE_TTL_MS = 15 * 60 * 1000;

/**
 * Whether an existing competition_baseline submission should block a new
 * attempt. This predicate is what makes ensureBaseline idempotent: "a healthy
 * one already exists" and "the last attempt died, retry" are the same question.
 *
 * The no-run case is the subtle one, and it bit in a live smoke. When the judge
 * is unavailable, judgeAndDispatch returns early and leaves the submission
 * stored as pending_review with NO run. Treating that as non-blocking was fine
 * while a human triggered baselines by hand -- a rare, deliberate action -- but
 * this now runs on every board render, so it created a fresh orphan per view,
 * unbounded. It therefore blocks WHILE FRESH, and only stops blocking once
 * stale, so a judge outage can't permanently deny the competition a baseline
 * either. Same shape as the run reaper's staleness rule.
 */
export function blocksNewBaseline(
  submission: Submission,
  run: Run | undefined,
  now: number = Date.now(),
  retryAfterRejection = false,
): boolean {
  // A rejected baseline means the FIXED vanilla prompt failed the fairness
  // judge -- systemic, and a human's problem, not something to retry. Left
  // non-blocking, every board render stored another rejected submission and
  // burned another judge call, forever. An explicit caller (the admin route)
  // can still override.
  if (submission.status === "rejected") return !retryAfterRejection;
  if (run) return !isInfraFailedRun(run);
  return now - Date.parse(submission.created_at) < PENDING_BASELINE_TTL_MS;
}

export type EnsureBaselineResult =
  | { kind: "already_present"; submissionId: string }
  | { kind: "created"; submissionId: string; runId: string; runIds: string[] }
  | { kind: "rejected"; submissionId: string; reason: string }
  | { kind: "judge_unavailable"; error: string };

/**
 * Gives `competition` a baseline if it does not already have a healthy one.
 *
 * Safe to call repeatedly -- that is the point. Competition creation kicks it
 * on the fast path, but creation must not depend on it: judging calls an
 * external LLM and dispatching costs money and takes minutes, while creating a
 * competition is a cheap write that has to succeed. So the trigger is
 * best-effort and this function, called again from the board read and the
 * daily cron, is what actually guarantees the baseline exists.
 */
// after() fires on every board render, so two sweeps can overlap inside one
// instance. Blob offers no compare-and-swap, so this is an in-process guard,
// not a distributed lock: it removes the common same-instance race. A
// cross-instance race remains possible and stays low-impact -- the board only
// ever surfaces the first baseline it finds, so a duplicate sits unused.
const inFlight = new Map<string, Promise<EnsureBaselineResult>>();

export async function ensureBaseline(
  storage: Storage,
  competition: Competition,
  options: { retryAfterRejection?: boolean } = {},
): Promise<EnsureBaselineResult> {
  const existingCall = inFlight.get(competition.id);
  if (existingCall) return existingCall;
  const call = ensureBaselineUncoordinated(storage, competition, options);
  inFlight.set(competition.id, call);
  try {
    return await call;
  } finally {
    inFlight.delete(competition.id);
  }
}

async function ensureBaselineUncoordinated(
  storage: Storage,
  competition: Competition,
  options: { retryAfterRejection?: boolean } = {},
): Promise<EnsureBaselineResult> {
  const [submissions, legacyOwnerId] = await Promise.all([
    storage.listSubmissions(),
    resolveLegacyOwnerId(storage),
  ]);
  const existing = submissions.filter(
    (s) => s.competition_baseline === true && belongsToCompetition(s, competition.id, legacyOwnerId),
  );
  const runs = await Promise.all(
    existing.map((s) => (s.run_id ? storage.getRun(s.run_id) : Promise.resolve(undefined))),
  );
  const blocking = existing.find((s, i) => blocksNewBaseline(s, runs[i], Date.now(), options.retryAfterRejection));
  if (blocking) return { kind: "already_present", submissionId: blocking.id };

  const submission: Submission = {
    id: randomUUID(),
    agent_name: BASELINE_AGENT_NAME,
    prompt: getBaselinePrompt(),
    status: "pending_review",
    model: competition.model,
    gateway_provider: competition.gateway_provider,
    competition: true,
    competition_id: competition.id,
    competition_baseline: true,
    created_at: new Date().toISOString(),
  };
  await storage.putSubmission(submission);

  const result = await judgeAndDispatch(storage, submission, "competition.baseline");
  if (result.kind === "judge_unavailable") return { kind: "judge_unavailable", error: result.error };
  if (result.kind === "rejected") {
    return { kind: "rejected", submissionId: result.submission.id, reason: result.verdict.reason };
  }
  return {
    kind: "created",
    submissionId: result.submission.id,
    runId: result.run.id,
    runIds: result.submission.run_ids ?? [result.run.id],
  };
}

/**
 * Backfills a baseline for every LIVE competition missing one.
 *
 * Scoped to live deliberately: closing a competition ends it, and a closed
 * board should not keep resurrecting baseline runs for a finished contest.
 *
 * Never throws. Callers are the board render and the cron sweep, and neither
 * should fail because one competition's judge call did -- the next call
 * retries it anyway.
 */
export async function ensureBaselines(storage: Storage): Promise<EnsureBaselineResult[]> {
  let competitions: Competition[];
  try {
    competitions = await storage.listCompetitions();
  } catch (error) {
    log("error", "competition.baseline.sweep_failed", { ...normalizeError(error, "competition_list") });
    return [];
  }

  const results: EnsureBaselineResult[] = [];
  for (const competition of competitions.filter((c) => c.status === "live" && c.auto_baseline !== false)) {
    try {
      const result = await ensureBaseline(storage, competition);
      if (result.kind !== "already_present") {
        log("info", "competition.baseline.ensured", { competition_id: competition.id, outcome: result.kind });
      }
      results.push(result);
    } catch (error) {
      log("error", "competition.baseline.ensure_failed", {
        competition_id: competition.id,
        ...normalizeError(error, "baseline_ensure"),
      });
    }
  }
  return results;
}
