import { NextRequest, NextResponse } from "next/server";
import { validateEntrantTraceManifest } from "@/lib/entrant-traces/manifest";
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

async function readBoundedJson(request: NextRequest): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413 }> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declared)) return { ok: false, status: 400 };
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes)) return { ok: false, status: 400 };
    if (bytes > MAX_REQUEST_BODY_BYTES) return { ok: false, status: 413 };
  }
  if (!request.body) return { ok: false, status: 400 };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder().decode(body)) };
  } catch {
    return { ok: false, status: 400 };
  } finally {
    reader.releaseLock();
  }
}

function parseBody(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!Object.keys(body).every((key) => key === "manifest" || key === "idempotency_key")) return null;
  if (typeof body.idempotency_key !== "string" || body.idempotency_key.length === 0 || body.idempotency_key.length > 256) return null;
  const manifest = validateEntrantTraceManifest(body.manifest);
  return manifest.ok ? { manifest: manifest.value, idempotency_key: body.idempotency_key } : null;
}

function safeArtifact(value: unknown) {
  const artifact = value as Record<string, unknown>;
  return {
    id: artifact.id,
    submission_id: artifact.submission_id,
    kind: artifact.kind,
    schema_version: artifact.schema_version,
    state: artifact.state,
    sha256: artifact.sha256,
    compression: artifact.compression,
    compressed_bytes: artifact.compressed_bytes,
    uncompressed_bytes: artifact.uncompressed_bytes,
    mime_type: artifact.mime_type,
  };
}

function safePreparedArtifacts(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const prepared = entry as Record<string, unknown>;
    const upload = prepared.upload as Record<string, unknown>;
    return { artifact: safeArtifact(prepared.artifact), upload: { method: upload?.method, url: upload?.url, headers: upload?.headers } };
  });
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const runtime = getAgentNetworkRuntime();
    const authentication = await runtime.authenticateAgentSession(request, { requiredScopes: ["competitions:read", "traces:write"] });
    if (!authentication.ok) return authenticationError(authentication.error.code);
    const payload = await readBoundedJson(request);
    if (!payload.ok) return error(payload.status === 413 ? "body_too_large" : "invalid_body", payload.status);
    const body = parseBody(payload.value);
    if (!body) return error("invalid_body", 400);
    const { id } = await params;
    if (id.length === 0 || id.length > 256 || body.manifest.submission_id !== id) return error("invalid_body", 400);
    const result = await runtime.prepareSubmissionTrace({ actor: authentication.actor, submission_id: id, ...body });
    if (!result.ok) {
      if (result.error.code === "not_found") return error("submission_not_found", 404);
      if (result.error.code === "conflict") return error("idempotency_conflict", 409);
      return error("trace_unavailable", 503);
    }
    return NextResponse.json({ artifacts: safePreparedArtifacts(result.artifacts) }, { status: 201 });
  } catch {
    return error("trace_unavailable", 503);
  }
}
