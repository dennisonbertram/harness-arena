import { gunzipSync } from "node:zlib";
import { NextRequest, NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";
import { resolveIdentity } from "@/lib/identity";

const VALID_NAMES = new Set(["session.jsonl", "pi-stdout.txt", "runner-log.txt", "verifier.txt"]);
const MAX_TRACE_TEXT_BYTES = 4 * 1024 * 1024;

// Serves a stored trace, decompressing it on read. Traces are stored gzipped
// (so the full untruncated trace fits under the upload body limit); this route
// gunzips them back to readable text. A blob that isn't gzipped (older traces)
// is served as-is via the magic-byte check.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await resolveIdentity(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const { id } = await params;
  const taskId = request.nextUrl.searchParams.get("task_id");
  const name = request.nextUrl.searchParams.get("name");
  if (!taskId || !name || !VALID_NAMES.has(name)) {
    return NextResponse.json({ error: "task_id and a valid name are required" }, { status: 400 });
  }

  const bytes = await getStorage().getTraceBytes(id, taskId, name);
  if (!bytes) {
    return NextResponse.json({ error: "trace not found" }, { status: 404 });
  }

  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  let text: string;
  try {
    text = (isGzip ? gunzipSync(bytes, { maxOutputLength: MAX_TRACE_TEXT_BYTES }) : bytes).toString("utf-8");
  } catch {
    return NextResponse.json({ error: "trace too large or invalid" }, { status: 413, headers: { "cache-control": "no-store" } });
  }
  if (Buffer.byteLength(text) > MAX_TRACE_TEXT_BYTES) {
    return NextResponse.json({ error: "trace too large" }, { status: 413, headers: { "cache-control": "no-store" } });
  }
  return new NextResponse(text, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
