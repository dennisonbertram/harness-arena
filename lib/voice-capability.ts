import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
const Id = z.uuid();
function secret() { const value = process.env.AUTH_SECRET; if (!value) throw new Error("voice capability secret missing"); return value; }
function signature(id: string) { return createHmac("sha256", secret()).update(`voice-evaluator:${id}`).digest("base64url"); }
export function mintVoiceCapability(id: string) { if (!Id.safeParse(id).success) throw new Error("invalid evaluator id"); return `${id}.${signature(id)}`; }
export function verifyVoiceCapability(value: string | undefined): string | undefined {
  const [id, actual, extra] = value?.split(".") ?? []; if (!id || !actual || extra || !Id.safeParse(id).success) return undefined;
  const expected = Buffer.from(signature(id)); const provided = Buffer.from(actual);
  return expected.length === provided.length && timingSafeEqual(expected, provided) ? id : undefined;
}
