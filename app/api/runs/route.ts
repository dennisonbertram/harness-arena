import { after, NextResponse } from "next/server";
import { dispatchQueuedRuns } from "@/lib/dispatch";
import { reapIfStale } from "@/lib/reaper";
import { runModel } from "@/lib/models";
import { getStorage } from "@/lib/storage";

export async function GET() {
  const storage = getStorage();
  const runs = await storage.listRuns();
  // Lazy reap: every poll of the run list is a chance to flip a stale run
  // (no events for 10+ minutes) to `reaped` instead of waiting on the
  // once-a-day cron (see app/api/cron/reap/route.ts).
  const current = await Promise.all(runs.map((run) => reapIfStale(storage, run).catch(() => run)));
  // Lazy dispatch: same pattern — a run-list poll (the pending page refreshes
  // every 15s) is a chance to start queued runs up to the concurrency cap, so
  // the queue drains without waiting on the daily cron.
  try {
    after(() => dispatchQueuedRuns(storage).catch(() => {}));
  } catch {
    void dispatchQueuedRuns(storage).catch(() => {});
  }
  // Always carry a model so consumers don't have to know the default; legacy
  // (pre-multi-model) runs read as glm-5.2.
  return NextResponse.json(current.map((r) => ({ ...r, model: runModel(r.model) })));
}
