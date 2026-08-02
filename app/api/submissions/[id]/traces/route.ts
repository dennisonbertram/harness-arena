import { NextRequest, NextResponse } from "next/server";
import { getAgentNetworkRuntime } from "@/lib/agent-network-runtime";

type RouteContext = { params: Promise<{ id: string }> };
function error(code: string, status: number) { return NextResponse.json({ error: { code } }, { status }); }
function authenticationError(code: string) {
  if (code === "unauthenticated") return error("unauthenticated", 401);
  if (code === "session_unavailable") return error("session_unavailable", 503);
  return error("insufficient_scope", 403);
}
function safeTrace(value: unknown) {
  const trace = value as Record<string, unknown>;
  return { id: trace.id, kind: trace.kind, schema_version: trace.schema_version, state: trace.state, sha256: trace.sha256, compression: trace.compression, mime_type: trace.mime_type };
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const runtime = getAgentNetworkRuntime();
    const authentication = await runtime.authenticateAgentSession(request, { requiredScopes: ["competitions:read", "traces:read"] });
    if (!authentication.ok) return authenticationError(authentication.error.code);
    const { id } = await params;
    if (id.length === 0 || id.length > 256) return error("submission_not_found", 404);
    const result = await runtime.getSubmissionTraceStatus({ actor: authentication.actor, submission_id: id });
    if (!result.ok) return result.error.code === "unavailable" ? error("trace_unavailable", 503) : error("submission_not_found", 404);
    return NextResponse.json({ traces: Array.isArray(result.traces) ? result.traces.map(safeTrace) : [] });
  } catch { return error("trace_unavailable", 503); }
}
