import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getVoiceStorage, type VoiceAudioKind } from "@/lib/voice-storage";

const EvaluatorId = z.uuid();
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

export async function GET(request: NextRequest, { params }: { params: Promise<{ kind: string; id: string }> }) {
  // The evaluator cookie is minted by /api/voice/next and is never a Blob
  // credential. It gates browser delivery while all Blob reads stay server-side.
  if (!EvaluatorId.safeParse(request.cookies.get("voice_evaluator")?.value).success) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const { kind, id } = await params;
  if ((kind !== "prompts" && kind !== "responses") || !Id.safeParse(id).success) {
    return NextResponse.json({ error: "not found" }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  const bytes = await getVoiceStorage().getAudioBytes(kind as VoiceAudioKind, id);
  if (!bytes) return NextResponse.json({ error: "not found" }, { status: 404, headers: { "cache-control": "no-store" } });
  if (bytes.byteLength > MAX_AUDIO_BYTES) return NextResponse.json({ error: "audio too large" }, { status: 413, headers: { "cache-control": "no-store" } });
  return new NextResponse(new Uint8Array(bytes), { headers: { "content-type": "audio/wav", "cache-control": "private, no-store" } });
}
