import { log } from "./log";
import { startRun } from "./run-trigger";
import type { Storage } from "./storage";
import type { Run } from "./types";

// Global concurrency cap: how many runs may hold a sandbox slot at once, across
// ALL submissions. The old path spawned a sandbox inline per submission with no
// cap; when several 5-run submissions landed together, ~15 concurrent
// Sandbox.create calls blew the serverless after() budget and every run stalled
// -> reaped. This cap + a bounded per-tick start count keeps creation within
// what one invocation can handle. Tune via env once the account's real limit is
// known.
const MAX_CONCURRENT_RUNS = Math.max(1, Math.floor(Number(process.env.MAX_CONCURRENT_RUNS ?? 3)) || 3);
// Cap on how many sandboxes a single dispatch invocation starts, so one
// after()/cron tick never tries to create too many at once (each create is a
// slow SDK call + bundle download). The rest drain on later ticks.
const MAX_STARTS_PER_TICK = Math.max(1, Math.floor(Number(process.env.MAX_STARTS_PER_TICK ?? 2)) || 2);

// A run holds a concurrency slot while it's running, or while it's been claimed
// for dispatch (dispatched_at set) and its sandbox is still spinning up. Terminal
// runs (completed/failed/reaped) free their slot; a claimed run that then stalls
// is freed by the reaper.
function holdsSlot(r: Run): boolean {
  return r.status === "running" || (r.status === "queued" && !!r.dispatched_at);
}

function isUnclaimed(r: Run): boolean {
  return r.status === "queued" && !r.dispatched_at;
}

/**
 * Pure selection: given the current runs and limits, which unclaimed queued runs
 * should start now. Oldest-first, bounded by both free slots and the per-tick
 * cap. Exported for testing without touching storage or sandboxes.
 */
export function selectRunsToStart(
  runs: Run[],
  cap: number = MAX_CONCURRENT_RUNS,
  maxPerTick: number = MAX_STARTS_PER_TICK,
): Run[] {
  const active = runs.filter(holdsSlot).length;
  const take = Math.min(Math.max(0, cap - active), maxPerTick);
  if (take <= 0) return [];
  return runs
    .filter(isUnclaimed)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, take);
}

type StartFn = (run: Run, prompt: string) => Promise<void>;

/**
 * Start as many queued runs as the concurrency cap allows (bounded per tick).
 * Claims each run (sets dispatched_at, persisted BEFORE the sandbox call) so a
 * concurrent dispatch is less likely to double-start it, then fires startRun
 * fire-and-forget — createRunSandbox marks the run failed on its own error, so a
 * broken start surfaces on the UI. Idempotent-ish and safe to call from any
 * trigger (submission, run completion, a run-list poll, the cron backstop).
 *
 * ponytail: the claim is a read-then-write on Blob, not a real CAS, so two
 * simultaneous dispatch invocations could still both claim the same run at POC
 * traffic. Add an atomic claim (or a single-writer cron) if double-starts appear.
 */
export async function dispatchQueuedRuns(storage: Storage, startFn: StartFn = startRun): Promise<string[]> {
  const runs = await storage.listRuns();
  const toStart = selectRunsToStart(runs);
  const started: string[] = [];
  for (const run of toStart) {
    const submission = await storage.getSubmission(run.submission_id);
    if (!submission) {
      log("warn", "dispatch.orphan_run", { run_id: run.id, submission_id: run.submission_id });
      continue;
    }
    // Claim BEFORE the sandbox call so concurrency accounting counts it and a
    // concurrent dispatch is less likely to double-start it.
    const claimed: Run = { ...run, dispatched_at: new Date().toISOString() };
    await storage.putRun(claimed);
    void startFn(claimed, submission.prompt).catch((err: unknown) =>
      log("warn", "run-trigger.failed", { run_id: run.id, error: (err as Error).message }),
    );
    started.push(run.id);
  }
  if (started.length > 0) log("info", "dispatch.started", { count: started.length, run_ids: started });
  return started;
}
