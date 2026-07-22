import { NextRequest, NextResponse } from "next/server";
import { log } from "@/lib/log";
import { verifyRunnerSecret } from "@/lib/runner-auth";
import { getStorage } from "@/lib/storage";

const VALID_NAMES = new Set(["session.jsonl", "pi-stdout.txt", "runner-log.txt"]);

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!verifyRunnerSecret(request)) {
    return new NextResponse(null, { status: 401 });
  }

  const storage = getStorage();
  const run = await storage.getRun(id);
  if (!run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  // ponytail: read-modify-write on the run doc (task_result.trace_blob_url
  // below) assumes the single sequential runner is the only writer during a
  // run (reaper only acts after inactivity). CAS/locking when concurrent
  // writers appear.

  const taskId = request.nextUrl.searchParams.get("task_id");
  const name = request.nextUrl.searchParams.get("name");
  if (!taskId || !name) {
    return NextResponse.json({ error: "task_id and name query params are required" }, { status: 400 });
  }
  if (!VALID_NAMES.has(name)) {
    return NextResponse.json({ error: `invalid trace name "${name}"` }, { status: 400 });
  }

  // The runner uploads traces gzip-compressed (so the full, untruncated trace
  // fits under the function body limit). We store the bytes as-is and expose a
  // view route that decompresses on read, so the linked URL stays readable.
  const buffer = Buffer.from(await request.arrayBuffer());
  await storage.putTraceBlob(id, taskId, name, buffer);
  const viewUrl = `${request.nextUrl.origin}/api/runs/${id}/trace-view?task_id=${encodeURIComponent(
    taskId,
  )}&name=${encodeURIComponent(name)}`;

  if (name === "session.jsonl") {
    const taskResult = run.task_results.find((tr) => tr.task_id === taskId);
    if (taskResult) {
      taskResult.trace_blob_url = viewUrl;
      await storage.putRun(run);
    }
  }

  log("info", "trace.received", { run_id: id, task_id: taskId, name });

  return NextResponse.json({ ok: true, url: viewUrl });
}
