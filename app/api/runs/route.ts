import { NextResponse } from "next/server";
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
  // Always carry a model so consumers don't have to know the default; legacy
  // (pre-multi-model) runs read as glm-5.2.
  return NextResponse.json(current.map((r) => ({ ...r, model: runModel(r.model) })));
}
