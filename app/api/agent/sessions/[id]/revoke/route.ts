import { NextRequest, NextResponse } from "next/server";
import { getAgentNetworkRuntime } from "@/lib/agent-network-runtime";

const MAX_REQUEST_BODY_BYTES = 1_048_576;
type RouteContext = { params: Promise<{ id: string }> };

function error(code: string, status: number) {
  return NextResponse.json({ error: { code } }, { status });
}

function authenticationError(code: string) {
  if (code === "unauthenticated") return error("unauthenticated", 401);
  if (code === "session_unavailable") return error("session_unavailable", 503);
  return error("insufficient_scope", 403);
}

async function isEmptyJsonObject(request: NextRequest): Promise<400 | 413 | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declared)) return 400;
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes)) return 400;
    if (bytes > MAX_REQUEST_BODY_BYTES) return 413;
  }
  if (!request.body) return 400;
  try {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        return 413;
      }
      chunks.push(value);
    }
    reader.releaseLock();
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0 ? null : 400;
  } catch {
    return 400;
  }
}

function isCanonicalSessionId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value);
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const runtime = getAgentNetworkRuntime();
    const authentication = await runtime.authenticateAgentSession(request, { requiredScopes: ["sessions:write"] });
    if (!authentication.ok) return authenticationError(authentication.error.code);
    const invalidBody = await isEmptyJsonObject(request);
    if (invalidBody) return error(invalidBody === 413 ? "body_too_large" : "invalid_body", invalidBody);
    const { id } = await params;
    if (!isCanonicalSessionId(id)) return error("invalid_session_id", 400);
    const result = await runtime.revokeAgentSession({ actor: authentication.actor, session_id: id });
    return result.ok ? NextResponse.json({ revoked: true }) : error("session_not_found", 404);
  } catch {
    return error("sessions_unavailable", 503);
  }
}
