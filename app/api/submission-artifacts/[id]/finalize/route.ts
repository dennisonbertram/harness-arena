import { NextRequest, NextResponse } from "next/server";
import { getAgentNetworkRuntime } from "@/lib/agent-network-runtime";

const MAX_REQUEST_BODY_BYTES = 1_048_576;
type RouteContext = { params: Promise<{ id: string }> };

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

function parseBody(value: unknown): { sha256: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1 && typeof body.sha256 === "string" && /^[0-9a-f]{64}$/.test(body.sha256) ? { sha256: body.sha256 } : null;
}
function safeArtifact(value: unknown) {
  const artifact = value as Record<string, unknown>;
  return { id: artifact.id, submission_id: artifact.submission_id, state: artifact.state, sha256: artifact.sha256, kind: artifact.kind, schema_version: artifact.schema_version };
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const runtime = getAgentNetworkRuntime();
    const authentication = await runtime.authenticateAgentSession(request, { requiredScopes: ["competitions:read", "traces:write"] });
    if (!authentication.ok) return authenticationError(authentication.error.code);
    const value = await readJson(request);
    if (value === 400 || value === 413) return error(value === 413 ? "body_too_large" : "invalid_body", value);
    const body = parseBody(value);
    if (!body) return error("invalid_body", 400);
    const { id } = await params;
    if (id.length === 0 || id.length > 256) return error("invalid_body", 400);
    const result = await runtime.finalizeSubmissionTrace({ actor: authentication.actor, artifact_id: id, sha256: body.sha256 });
    if (!result.ok) {
      if (result.error.code === "not_found") return error("artifact_not_found", 404);
      if (result.error.code === "invalid_state") return error("invalid_artifact_state", 409);
      if (result.error.code === "conflict") return error("checksum_conflict", 409);
      return error("trace_unavailable", 503);
    }
    return NextResponse.json({ artifact: safeArtifact(result.artifact) });
  } catch { return error("trace_unavailable", 503); }
}
