import { NextResponse } from "next/server";
import { dispatchQueuedRuns } from "@/lib/dispatch";
import { log } from "@/lib/log";
import { reapStaleRuns } from "@/lib/reaper";
import { getStorage } from "@/lib/storage";

// Vercel Cron target (see vercel.json). Hobby-plan crons only run once a
// day, so this sweep is a backstop -- the lazy reap wired into GET
// /api/runs and GET /api/runs/[id] is the primary path (it fires on every
// poll from the web UI, so a stale run typically flips to `reaped` within
// seconds of someone looking at it, not once a day).
export async function GET() {
  const storage = getStorage();
  const reaped = await reapStaleRuns(storage);
  // Reaping frees concurrency slots (stuck runs), so dispatch right after to
  // start queued runs. This is the daily backstop for the lazy dispatch on
  // GET /api/runs and the run-completion trigger.
  const started = await dispatchQueuedRuns(storage).catch(() => [] as string[]);
  log("info", "cron.reap", {
    reaped_count: reaped.length,
    reaped_run_ids: reaped.map((r) => r.id),
    dispatched_count: started.length,
  });
  return NextResponse.json({ reaped: reaped.length, dispatched: started.length });
}
