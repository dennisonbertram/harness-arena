import { NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";
import { getVoiceStorage } from "@/lib/voice-storage";

export const dynamic = "force-dynamic";

/** Readiness deliberately probes storage, rather than reporting an open TCP port. */
export async function GET() {
  try {
    await Promise.all([getStorage().listRuns(), getStorage().listSubmissions(), getVoiceStorage().getManifest()]);
    return NextResponse.json({ ok: true, storage: "ready" });
  } catch {
    return NextResponse.json({ ok: false, storage: "unready" }, { status: 503 });
  }
}
