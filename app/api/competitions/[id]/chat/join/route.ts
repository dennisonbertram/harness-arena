import { NextRequest, NextResponse } from "next/server";
import { getAgentNetworkRuntime } from "@/lib/agent-network-runtime";

type RouteContext = { params: Promise<{ id: string }> };

function error(code: string, status: number) {
  return NextResponse.json({ error: { code } }, { status });
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const runtime = getAgentNetworkRuntime();
    const authentication = await runtime.authenticateAgentSession(request, { requiredScopes: ["competitions:read", "chat:write"] });
    if (!authentication.ok) {
      if (authentication.error.code === "unauthenticated") return error("unauthenticated", 401);
      if (authentication.error.code === "session_unavailable") return error("session_unavailable", 503);
      return error("insufficient_scope", 403);
    }

    const { id } = await params;
    if (!await runtime.getLiveCompetition(id)) return error("competition_not_found", 404);
    const result = await runtime.joinCompetitionChat({ actor: authentication.actor, competition_id: id });
    if (!result.ok) return result.error.code === "conflict" ? error("membership_conflict", 409) : error("chat_unavailable", 503);
    return NextResponse.json({ membership: result.membership });
  } catch {
    return error("chat_unavailable", 503);
  }
}
