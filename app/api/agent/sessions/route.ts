import { NextRequest, NextResponse } from "next/server";
import { getAgentNetworkRuntime } from "@/lib/agent-network-runtime";

function error(code: string, status: number) {
  return NextResponse.json({ error: { code } }, { status });
}

function authenticationError(code: string) {
  if (code === "unauthenticated") return error("unauthenticated", 401);
  if (code === "session_unavailable") return error("session_unavailable", 503);
  return error("insufficient_scope", 403);
}

export async function GET(request: NextRequest) {
  try {
    const runtime = getAgentNetworkRuntime();
    const authentication = await runtime.authenticateAgentSession(request, { requiredScopes: ["sessions:read"] });
    if (!authentication.ok) return authenticationError(authentication.error.code);
    return NextResponse.json(await runtime.listAgentSessions({ actor: authentication.actor }));
  } catch {
    return error("sessions_unavailable", 503);
  }
}
