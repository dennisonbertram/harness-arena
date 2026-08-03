import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const Id = z.uuid();
const VERSION = "v1";
export const VOICE_CAPABILITY_LIFETIME_SECONDS = 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("voice capability secret missing");
  return value;
}

function signature(payload: string): string {
  return createHmac("sha256", secret()).update(`voice-evaluator:${payload}`).digest("base64url");
}

export function mintVoiceCapability(
  id: string,
  { now = Date.now(), lifetimeSeconds = VOICE_CAPABILITY_LIFETIME_SECONDS }: { now?: number; lifetimeSeconds?: number } = {},
): string {
  if (!Id.safeParse(id).success) throw new Error("invalid evaluator id");
  if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds <= 0 || lifetimeSeconds > VOICE_CAPABILITY_LIFETIME_SECONDS) {
    throw new Error("invalid voice capability lifetime");
  }
  const issuedAt = Math.floor(now / 1000);
  const payload = `${VERSION}.${id}.${issuedAt}.${issuedAt + lifetimeSeconds}`;
  return `${payload}.${signature(payload)}`;
}

export function verifyVoiceCapability(value: string | undefined, { now = Date.now() }: { now?: number } = {}): string | undefined {
  const [version, id, issuedRaw, expiresRaw, actual, extra] = value?.split(".") ?? [];
  if (version !== VERSION || !id || !issuedRaw || !expiresRaw || !actual || extra || !Id.safeParse(id).success) return undefined;
  const issuedAt = Number(issuedRaw);
  const expiresAt = Number(expiresRaw);
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return undefined;
  if (expiresAt <= issuedAt || expiresAt - issuedAt > VOICE_CAPABILITY_LIFETIME_SECONDS) return undefined;
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS || expiresAt < nowSeconds - CLOCK_SKEW_SECONDS) return undefined;
  const payload = `${version}.${id}.${issuedAt}.${expiresAt}`;
  const expected = Buffer.from(signature(payload));
  const provided = Buffer.from(actual);
  return expected.length === provided.length && timingSafeEqual(expected, provided) ? id : undefined;
}
