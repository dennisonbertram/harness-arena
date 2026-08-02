import { NextRequest, NextResponse } from "next/server";
import { redactRunEventPayload } from "@/lib/run-error";
import { getStorage } from "@/lib/storage";

/**
 * Run events, oldest-first.
 *
 * `?since=<seq>` returns only events after that seq -- the incremental path
 * for pollers. Without it the whole log is returned (unchanged behavior, so
 * existing callers keep working). A malformed `since` is treated as absent
 * rather than a 400: this is a read-only feed, and degrading to "send
 * everything" is safer for a live-updating UI than failing the request.
 *
 * Resume by taking the last element's `seq`; an empty array means nothing
 * new, so the caller keeps its existing cursor.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const storage = getStorage();

  const raw = request.nextUrl.searchParams.get("since");
  const parsed = raw === null ? Number.NaN : Number(raw);
  const since = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;

  const events = since === null ? await storage.listRunEvents(id) : await storage.listRunEventsSince(id, since);
  return NextResponse.json(events.map((event) => ({
    ...event,
    payload: redactRunEventPayload(event.type, event.payload),
  })));
}
