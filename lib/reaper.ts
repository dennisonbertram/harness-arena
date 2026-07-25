import type { Storage } from "./storage";
import type { Run } from "./types";

// Default raised from 10 to 20 minutes (issue #23 finding F5) once the
// per-task timeout caps in lib/tasks-for-runner.ts bound worst-case
// per-task quiet time to ~300+240+setup =~ 10 minutes -- 10 minutes left
// zero margin. Override via REAP_STALE_MINUTES; read per-call (not cached
// at module load) so tests/ops can override without a process restart.
const DEFAULT_REAP_STALE_MINUTES = 20;

function reapThresholdMs(): number {
  const minutes = Number(process.env.REAP_STALE_MINUTES ?? DEFAULT_REAP_STALE_MINUTES);
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
  if (!isReapCandidate(run)) return run;

  // Cheap staleness probe (list metadata only). Using listRunEvents here
  // would fetch every event blob's content on every run read — a fetch-storm
  // that rate-limits Blob (403) and crashed the read routes.
  const lastEventTs = (await storage.latestEventTimestamp(run.id)) ?? run.created_at;
  if (!shouldReap(run, lastEventTs, now)) return run;
  // ponytail: read-then-write is not atomic — a runner callback that lands
  // between the freshness check and putRun could be overwritten. Bounded in
  // practice: the 20-min threshold far exceeds the max per-task quiet period,
  // so a run this stale has almost certainly stopped emitting. Move to a CAS/
  // conditional write if concurrent writers ever become real.

  const reaped: Run = { ...run, status: "reaped", finished_at: new Date(now).toISOString() };
  await storage.putRun(reaped);
  await storage.appendRunEvents(run.id, [
    {
      ts: new Date(now).toISOString(),
      type: "run.reaped",
      payload: { reason: `no events for over ${reapThresholdMs() / 60000} minutes` },
    },
  ]);
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
