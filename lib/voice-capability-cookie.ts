import { type NextResponse } from "next/server";
import { mintVoiceCapability, VOICE_CAPABILITY_LIFETIME_SECONDS } from "./voice-capability";

export const VOICE_CAPABILITY_COOKIE_NAME = "voice_evaluator";

export function setVoiceCapabilityCookie(response: NextResponse, evaluatorId: string): void {
  response.cookies.set(VOICE_CAPABILITY_COOKIE_NAME, mintVoiceCapability(evaluatorId), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: VOICE_CAPABILITY_LIFETIME_SECONDS,
    secure: true,
  });
}
