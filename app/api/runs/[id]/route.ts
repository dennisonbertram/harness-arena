import { after, NextRequest, NextResponse } from "next/server";
import { dispatchQueuedRuns } from "@/lib/dispatch";
import { reapIfStale } from "@/lib/reaper";
import { runModel } from "@/lib/models";
import { getStorage } from "@/lib/storage";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const storage = getStorage();
  const run = await storage.getRun(id);
  if (!run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  // Lazy reap: see app/api/runs/route.ts. Reaping must never break the read —
  // if the staleness probe transiently fails, return the run as-is.
  const current = await reapIfStale(storage, run).catch(() => run);
  if (current.status === "reaped" && run.status !== "reaped") {
    // Reaping freed a concurrency slot. Let the response return immediately,
    // then give the oldest queued run a chance to claim it.
    try {
      after(() => dispatchQueuedRuns(storage).catch(() => {}));
    } catch {
      void dispatchQueuedRuns(storage).catch(() => {});
    }
  }
  return NextResponse.json({ ...current, model: runModel(current.model) });
}
