import { mintVoiceCapability } from "@/lib/voice-capability";

export const TEST_AUTH_SECRET = "test-auth-secret-with-at-least-thirty-two-bytes";
export function installVoiceCapabilityTestSecret(): void { process.env.AUTH_SECRET = TEST_AUTH_SECRET; }
export function voiceCapabilityCookie(evaluatorId: string): string { return mintVoiceCapability(evaluatorId); }
