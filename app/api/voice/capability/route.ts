import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyVoiceCapability } from "@/lib/voice-capability";
import { setVoiceCapabilityCookie, VOICE_CAPABILITY_COOKIE_NAME } from "@/lib/voice-capability-cookie";

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  }
  const existing = verifyVoiceCapability(request.cookies.get(VOICE_CAPABILITY_COOKIE_NAME)?.value);
  const response = new NextResponse(null, { status: 204, headers: { "cache-control": "private, no-store" } });
  if (!existing) setVoiceCapabilityCookie(response, randomUUID());
  return response;
}
