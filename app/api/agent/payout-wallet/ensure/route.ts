import { NextRequest, NextResponse } from "next/server";
import { getAgentNetworkRuntime } from "@/lib/agent-network-runtime";

function error(code: string, status: number) { return NextResponse.json({ error: { code } }, { status }); }
function authenticationError(code: string) {
  if (code === "unauthenticated") return error("unauthenticated", 401);
  if (code === "session_unavailable") return error("session_unavailable", 503);
  return error("insufficient_scope", 403);
}

async function hasExactEmptyObject(request: NextRequest): Promise<boolean> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0;
  } catch { return false; }
}

export async function POST(request: NextRequest) {
  try {
    const runtime = getAgentNetworkRuntime();
    const authentication = await runtime.authenticateAgentSession(request, { requiredScopes: ["payouts:write"] });
    if (!authentication.ok) return authenticationError(authentication.error.code);
    if (!(await hasExactEmptyObject(request))) return error("invalid_body", 400);
    // Provisioning is intentionally disabled until the separately reviewed Privy
    // proof of concept and development-environment configuration exist.
    return error("feature_unavailable", 503);
  } catch { return error("feature_unavailable", 503); }
}
