import type { Storage } from "./storage";
import { buildRunnerTasks } from "./tasks-for-runner";
import type { Run } from "./types";

const REAP_SAFETY_MARGIN_MINUTES = 10;
const REAP_WINDOW_ROUNDING_MINUTES = 10;

// A healthy runner emits no events between task.started and the end of the
// agent/verifier stages. Derive the stale window from the longest task instead
// of maintaining a second hand-written timeout that can drift below it.
function defaultReapStaleMinutes(): number {
  const maxQuietSeconds = Math.max(
    0,
    ...buildRunnerTasks().map((task) => task.agent_timeout_sec + task.verifier_timeout_sec),
  );
  const requiredMinutes = maxQuietSeconds / 60 + REAP_SAFETY_MARGIN_MINUTES;
  return (
    Math.ceil(requiredMinutes / REAP_WINDOW_ROUNDING_MINUTES) *
    REAP_WINDOW_ROUNDING_MINUTES
  );
}

export function reapThresholdMs(): number {
  const fallbackMinutes = defaultReapStaleMinutes();
  const configured = Number(process.env.REAP_STALE_MINUTES ?? fallbackMinutes);
  const minutes = Number.isFinite(configured) && configured > 0 ? configured : fallbackMinutes;
  return minutes * 60 * 1000;
}

// A run is a reap candidate only if it's actively occupying a sandbox slot: a
// running run, or a QUEUED run that the dispatcher has claimed (dispatched_at
// set) and whose sandbox may have stalled. An undispatched queued run is simply
// WAITING for a concurrency slot behind the global cap -- not stuck -- so it is
// never reaped; it starts when a slot frees. (Before the dispatcher, every
// queued run was already being started inline, so "queued + silent" meant stuck;
// with a real queue that's no longer true.)
function isReapCandidate(run: Run): boolean {
  return run.status === "running" || (run.status === "queued" && !!run.dispatched_at);
}

async function markSubmissionFailed(storage: Storage, run: Run): Promise<void> {
  const submission = await storage.getSubmission(run.submission_id);
  if (
    submission?.run_id === run.id &&
    (submission.status === "queued" || submission.status === "running")
  ) {
    submission.status = "failed";
    await storage.putSubmission(submission);
  }
}

/**
 * Pure predicate: a reap-candidate run is stale once it's been silent for over
 * the threshold (default 20 min). Dispatch resets the clock — a freshly-claimed
 * run whose last EVENT is old (it waited in the queue) counts its dispatch time
 * as activity, so it isn't reaped before its sandbox posts its first event.
 * Terminal runs and undispatched-queued (waiting) runs are never reaped.
 */
export function shouldReap(run: Run, lastEventTs: string, now: number = Date.now()): boolean {
  if (!isReapCandidate(run)) return false;
  const lastActivity = Math.max(
    new Date(lastEventTs).getTime(),
    run.dispatched_at ? new Date(run.dispatched_at).getTime() : 0,
  );
  return now - lastActivity > reapThresholdMs();
}

/**
 * Reaps a single run if it's stale, returning the (possibly updated) run.
 * Idempotent: a run already in a terminal status is returned untouched.
 */
export async function reapIfStale(storage: Storage, run: Run, now: number = Date.now()): Promise<Run> {
  // Reconcile historical rows and partial writes where the terminal run write
  // succeeded but the following parent-submission write did not. Completed
  // runs are synchronized by their result callback; failure-like terminal
  // states both map to the same parent status.
  if (run.status === "reaped" || run.status === "failed") {
    await markSubmissionFailed(storage, run);
    return run;
  }
  if (!isReapCandidate(run)) return run;

  // Cheap staleness probe (list metadata only). Using listRunEvents here
  // would fetch every event blob's content on every run read — a fetch-storm
  // that rate-limits Blob (403) and crashed the read routes.
  const lastEventTs = (await storage.latestEventTimestamp(run.id)) ?? run.created_at;
  if (!shouldReap(run, lastEventTs, now)) return run;
  // ponytail: read-then-write is not atomic — a runner callback that lands
  // between the freshness check and putRun could be overwritten. Bounded in
  // practice: the task-derived threshold exceeds the max per-task quiet period
  // with an additional safety margin, so a run this stale has almost certainly
  // stopped emitting. Move to a CAS/conditional write if concurrent writers
  // ever become real.

  const reaped: Run = { ...run, status: "reaped", finished_at: new Date(now).toISOString() };
  await storage.putRun(reaped);
  await storage.appendRunEvents(run.id, [
    {
      ts: new Date(now).toISOString(),
      type: "run.reaped",
      payload: { reason: `no events for over ${reapThresholdMs() / 60000} minutes` },
    },
  ]);
  await markSubmissionFailed(storage, run);
  return reaped;
}

/** Sweeps every run in storage, reaping the stale ones. Used by the cron target. */
export async function reapStaleRuns(storage: Storage, now: number = Date.now()): Promise<Run[]> {
  const runs = await storage.listRuns();
  const reaped: Run[] = [];
  for (const run of runs) {
    const result = await reapIfStale(storage, run, now);
    if (result.status === "reaped" && run.status !== "reaped") reaped.push(result);
  }
  return reaped;
}
