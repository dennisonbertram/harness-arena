import { gunzipSync } from "node:zlib";
import { NextRequest, NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";

const VALID_NAMES = new Set(["session.jsonl", "pi-stdout.txt", "runner-log.txt"]);

// Serves a stored trace, decompressing it on read. Traces are stored gzipped
// (so the full untruncated trace fits under the upload body limit); this route
// gunzips them back to readable text. A blob that isn't gzipped (older traces)
// is served as-is via the magic-byte check.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  const text = (isGzip ? gunzipSync(bytes) : bytes).toString("utf-8");
  return new NextResponse(text, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
