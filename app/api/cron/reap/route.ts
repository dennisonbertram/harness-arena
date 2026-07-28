import { NextResponse } from "next/server";
import { ensureBaselines } from "@/lib/competition-baseline";
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
  // Backstop for the baseline the create route kicked and the board render
  // retries: if both missed (judge outage during creation, nobody viewed the
  // board), this is the last line that guarantees a live competition has a
  // reference point.
  const baselines = await ensureBaselines(storage);
  log("info", "cron.reap", {
    reaped_count: reaped.length,
    reaped_run_ids: reaped.map((r) => r.id),
    dispatched_count: started.length,
    baselines_ensured: baselines.filter((b) => b.kind === "created").length,
  });
  return NextResponse.json({
    reaped: reaped.length,
    dispatched: started.length,
    baselines_ensured: baselines.filter((b) => b.kind === "created").length,
  });
}
