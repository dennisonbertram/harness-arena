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
function parseBody(value: unknown): { address: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1 && typeof body.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(body.address) ? { address: body.address } : null;
}
function safeChallenge(value: unknown) {
  const challenge = value as Record<string, unknown>;
  return { id: challenge.id, address: challenge.address, chain_id: challenge.chain_id, expires_at: challenge.expires_at, message: challenge.message };
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
    const result = await runtime.prepareExternalPayoutAddress({ actor: authentication.actor, address: body.address });
    if (!result.ok) {
      if (result.error.code === "recent_authentication_required") return error("recent_authentication_required", 403);
      if (result.error.code === "rate_limited") return error("rate_limited", 429);
      return error("payout_profile_unavailable", 503);
    }
    return NextResponse.json({ challenge: safeChallenge(result.challenge) }, { status: 201 });
  } catch { return error("payout_profile_unavailable", 503); }
}
