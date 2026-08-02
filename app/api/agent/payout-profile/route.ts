import { NextRequest, NextResponse } from "next/server";
import { getAgentNetworkRuntime } from "@/lib/agent-network-runtime";

function error(code: string, status: number) { return NextResponse.json({ error: { code } }, { status }); }
function authenticationError(code: string) {
  if (code === "unauthenticated") return error("unauthenticated", 401);
  if (code === "session_unavailable") return error("session_unavailable", 503);
  return error("insufficient_scope", 403);
}
function safeProfile(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const profile = value as Record<string, unknown>;
  return {
    provider: profile.provider,
    address: profile.address,
    chain_id: profile.chain_id,
    verification_method: profile.verification_method,
    consent_version: profile.consent_version,
    verified_at: profile.verified_at,
    change_effective_at: profile.change_effective_at,
    effective: profile.effective,
  };
}

export async function GET(request: NextRequest) {
  try {
    const runtime = getAgentNetworkRuntime();
    const authentication = await runtime.authenticateAgentSession(request, { requiredScopes: ["payouts:read"] });
    if (!authentication.ok) return authenticationError(authentication.error.code);
    const result = await runtime.getPayoutProfile({ actor: authentication.actor });
    if (!result.ok) return error("payout_profile_unavailable", 503);
    return NextResponse.json({ profile: safeProfile(result.profile) });
  } catch { return error("payout_profile_unavailable", 503); }
}
