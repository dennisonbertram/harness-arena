import { NextRequest, NextResponse } from "next/server";
import { log } from "@/lib/log";
import { verifyRunnerSecret } from "@/lib/runner-auth";
import { getStorage } from "@/lib/storage";
import { readBoundedStream } from "@/lib/bounded-stream";

const VALID_NAMES = new Set(["session.jsonl", "pi-stdout.txt", "runner-log.txt", "verifier.txt"]);
const MAX_TRACE_UPLOAD_BYTES = 4 * 1024 * 1024;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!verifyRunnerSecret(request)) {
    return new NextResponse(null, { status: 401 });
  }

  const taskId = request.nextUrl.searchParams.get("task_id");
  const name = request.nextUrl.searchParams.get("name");
  if (!taskId || !name) {
    return NextResponse.json({ error: "task_id and name query params are required" }, { status: 400 });
  }
  if (!VALID_NAMES.has(name)) {
    return NextResponse.json({ error: `invalid trace name "${name}"` }, { status: 400 });
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || !/^[A-Za-z0-9._-]{1,128}$/.test(taskId)) return NextResponse.json({ error: "invalid identifier" }, { status: 400 });

  const storage = getStorage();
  const run = await storage.getRun(id);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
  const taskResult = run.task_results.find((result) => result.task_id === taskId);
  if ((taskId === "_run" && name !== "runner-log.txt") || (taskId !== "_run" && !taskResult)) {
    return NextResponse.json({ error: "trace task does not belong to run" }, { status: 400 });
  }

  // ponytail: read-modify-write on the run doc assumes the single sequential
  // runner is the only writer during a run.

  // The runner uploads traces gzip-compressed (so the full, untruncated trace
  // fits under the function body limit). We store the bytes as-is and expose a
  // view route that decompresses on read, so the linked URL stays readable.
  if (!request.body) return NextResponse.json({ error: "trace body is required" }, { status: 400 });
  let buffer: Buffer;
  try { buffer = await readBoundedStream(request.body, MAX_TRACE_UPLOAD_BYTES); }
  catch { return NextResponse.json({ error: "trace too large" }, { status: 413 }); }
  await storage.putTraceBlob(id, taskId, name, buffer);
  const viewUrl = `${request.nextUrl.origin}/api/runs/${id}/trace-view?task_id=${encodeURIComponent(
    taskId,
  )}&name=${encodeURIComponent(name)}`;

  if (name === "session.jsonl") {
    if (taskResult) {
      taskResult.trace_blob_url = viewUrl;
      await storage.putRun(run);
    }
  }

  log("info", "trace.received", { run_id: id, task_id: taskId, name });

  return NextResponse.json({ ok: true, url: viewUrl });
}
