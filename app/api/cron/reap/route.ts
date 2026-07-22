import { NextResponse } from "next/server";
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
  log("info", "cron.reap", { reaped_count: reaped.length, reaped_run_ids: reaped.map((r) => r.id) });
  return NextResponse.json({ reaped: reaped.length });
}
