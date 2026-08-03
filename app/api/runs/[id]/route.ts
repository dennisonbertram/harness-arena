import { after, NextRequest, NextResponse } from "next/server";
import { dispatchQueuedRuns } from "@/lib/dispatch";
import { reapIfStale } from "@/lib/reaper";
import { runModel } from "@/lib/models";
import { getStorage } from "@/lib/storage";
import { log, normalizeError } from "@/lib/log";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const storage = getStorage();
  const run = await storage.getRun(id);
  if (!run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  // Lazy reap: see app/api/runs/route.ts. Reaping must never break the read —
  // if the staleness probe transiently fails, return the run as-is.
  const current = await reapIfStale(storage, run).catch((error: unknown) => {
    log("error", "run.reap_failed", { run_id: id, ...normalizeError(error, "reap") });
    return run;
  });
  if (current.status === "reaped" && run.status !== "reaped") {
    // Reaping freed a concurrency slot. Let the response return immediately,
    // then give the oldest queued run a chance to claim it.
    try {
      after(() => dispatchQueuedRuns(storage).catch((error: unknown) => {
        log("error", "run.dispatch_failed", { run_id: id, ...normalizeError(error, "dispatch") });
      }));
    } catch {
      void dispatchQueuedRuns(storage).catch((error: unknown) => {
        log("error", "run.dispatch_failed", { run_id: id, ...normalizeError(error, "dispatch") });
      });
    }
  }
  return NextResponse.json({ ...current, model: runModel(current.model) });
}
