import { NextRequest, NextResponse } from "next/server";
import { getAgentNetworkRuntime } from "@/lib/agent-network-runtime";

const MAX_REQUEST_BODY_BYTES = 1_048_576;
function error(code: string, status: number) { return NextResponse.json({ error: { code } }, { status }); }
function authenticationError(code: string) {
  if (code === "unauthenticated") return error("unauthenticated", 401);
  if (code === "session_unavailable") return error("session_unavailable", 503);
  return error("insufficient_scope", 403);
}
async function readJson(request: NextRequest): Promise<unknown | 400 | 413> {
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(length)) return 400;
    const bytes = Number(length);
    if (!Number.isSafeInteger(bytes)) return 400;
    if (bytes > MAX_REQUEST_BODY_BYTES) return 413;
  }
  if (!request.body) return 400;
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_REQUEST_BODY_BYTES) { await reader.cancel(); return 413; } chunks.push(value); }
    const data = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(data));
  } catch { return 400; } finally { reader.releaseLock(); }
}
function parseBody(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!Object.keys(body).every((key) => key === "challenge_id" || key === "signature" || key === "consent_version" || key === "idempotency_key")) return null;
  if (Object.keys(body).length !== 4 || typeof body.challenge_id !== "string" || body.challenge_id.length === 0 || body.challenge_id.length > 256) return null;
  if (typeof body.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) return null;
  if (typeof body.consent_version !== "string" || body.consent_version.length === 0 || body.consent_version.length > 128) return null;
  if (typeof body.idempotency_key !== "string" || body.idempotency_key.length === 0 || body.idempotency_key.length > 256) return null;
  return { challenge_id: body.challenge_id, signature: body.signature, consent_version: body.consent_version, idempotency_key: body.idempotency_key };
}
function safeProfile(value: unknown) {
  const profile = value as Record<string, unknown>;
  return { provider: profile.provider, address: profile.address, chain_id: profile.chain_id, verification_method: profile.verification_method, consent_version: profile.consent_version, verified_at: profile.verified_at, change_effective_at: profile.change_effective_at, effective: profile.effective };
}
export async function POST(request: NextRequest) {
  try {
    const runtime = getAgentNetworkRuntime();
    const authentication = await runtime.authenticateAgentSession(request, { requiredScopes: ["payouts:write"] });
    if (!authentication.ok) return authenticationError(authentication.error.code);
    const value = await readJson(request);
    if (value === 400 || value === 413) return error(value === 413 ? "body_too_large" : "invalid_body", value);
    const body = parseBody(value);
    if (!body) return error("invalid_body", 400);
    const result = await runtime.verifyExternalPayoutAddress({ actor: authentication.actor, ...body });
    if (!result.ok) {
      if (result.error.code === "challenge_consumed") return error("challenge_consumed", 409);
      if (result.error.code === "idempotency_conflict") return error("idempotency_conflict", 409);
      if (result.error.code === "recent_authentication_required") return error("recent_authentication_required", 403);
      if (result.error.code === "rate_limited") return error("rate_limited", 429);
      return error("payout_profile_unavailable", 503);
    }
    return NextResponse.json({ profile: safeProfile(result.profile) });
  } catch { return error("payout_profile_unavailable", 503); }
}
