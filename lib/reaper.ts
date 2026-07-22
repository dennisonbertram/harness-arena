import type { Storage } from "./storage";
import type { Run } from "./types";

// Default raised from 10 to 20 minutes (issue #23 finding F5) once the
// per-task timeout caps in lib/tasks-for-runner.ts bound worst-case
// per-task quiet time to ~300+240+setup =~ 10 minutes -- 10 minutes left
// zero margin. Override via REAP_STALE_MINUTES; read per-call (not cached
// at module load) so tests/ops can override without a process restart.
const DEFAULT_REAP_STALE_MINUTES = 20;
const REAPABLE_STATUSES = new Set<Run["status"]>(["queued", "running"]);

function reapThresholdMs(): number {
  const minutes = Number(process.env.REAP_STALE_MINUTES ?? DEFAULT_REAP_STALE_MINUTES);
  return minutes * 60 * 1000;
}

/**
 * Pure predicate: a run is stale once it's been silent (no new events) for
 * over the stale threshold (default 20 minutes) while still in a
 * non-terminal status. Terminal statuses (completed/failed/reaped) are
 * never reaped, no matter how old.
 */
export function shouldReap(run: Run, lastEventTs: string, now: number = Date.now()): boolean {
  if (!REAPABLE_STATUSES.has(run.status)) return false;
  return now - new Date(lastEventTs).getTime() > reapThresholdMs();
}

/**
 * Reaps a single run if it's stale, returning the (possibly updated) run.
 * Idempotent: a run already in a terminal status is returned untouched.
 */
export async function reapIfStale(storage: Storage, run: Run, now: number = Date.now()): Promise<Run> {
  if (!REAPABLE_STATUSES.has(run.status)) return run;

  const events = await storage.listRunEvents(run.id);
  const lastEventTs = events.length > 0 ? events[events.length - 1].ts : run.created_at;
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
