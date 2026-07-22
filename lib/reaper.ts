import type { Storage } from "./storage";
import type { Run } from "./types";

// Decided value from the spec sheet, not a placeholder (issue #7).
const REAP_THRESHOLD_MS = 10 * 60 * 1000;
const REAPABLE_STATUSES = new Set<Run["status"]>(["queued", "running"]);

/**
 * Pure predicate: a run is stale once it's been silent (no new events) for
 * over 10 minutes while still in a non-terminal status. Terminal statuses
 * (completed/failed/reaped) are never reaped, no matter how old.
 */
export function shouldReap(run: Run, lastEventTs: string, now: number = Date.now()): boolean {
  if (!REAPABLE_STATUSES.has(run.status)) return false;
  return now - new Date(lastEventTs).getTime() > REAP_THRESHOLD_MS;
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

  const reaped: Run = { ...run, status: "reaped", finished_at: new Date(now).toISOString() };
  await storage.putRun(reaped);
  await storage.appendRunEvents(run.id, [
    { ts: new Date(now).toISOString(), type: "run.reaped", payload: { reason: "no events for over 10 minutes" } },
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
