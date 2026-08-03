import { NextRequest, NextResponse } from "next/server";
import { getAgentNetworkRuntime } from "@/lib/agent-network-runtime";

const MAX_REQUEST_BODY_BYTES = 1_048_576;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_LIMIT = 100;
const MAX_WAIT_SECONDS = 25;

type RouteContext = { params: Promise<{ id: string }> };

function error(code: string, status: number) {
  return NextResponse.json({ error: { code } }, { status });
}

function mapAuthenticationError(code: string) {
  if (code === "unauthenticated") return error("unauthenticated", 401);
  if (code === "session_unavailable") return error("session_unavailable", 503);
  return error("insufficient_scope", 403);
}

function parseInteger(value: string, minimum: number, maximum: number): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function parseQuery(request: NextRequest): { cursor?: string; limit?: number; wait_seconds?: number } | null {
  const params = request.nextUrl.searchParams;
  const allowed = new Set(["after_cursor", "limit", "wait_seconds"]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) return null;
  }

  const cursor = params.get("after_cursor");
  if (cursor !== null && cursor.length === 0) return null;

  const limitValue = params.get("limit");
  let limit: number | undefined;
  if (limitValue !== null) {
    const parsed = parseInteger(limitValue, 1, MAX_LIMIT);
    if (parsed === null) return null;
    limit = parsed;
  }

  const waitValue = params.get("wait_seconds");
  let wait_seconds: number | undefined;
  if (waitValue !== null) {
    const parsed = parseInteger(waitValue, 0, MAX_WAIT_SECONDS);
    if (parsed === null) return null;
    wait_seconds = parsed;
  }

  return { ...(cursor === null ? {} : { cursor }), ...(limit === undefined ? {} : { limit }), ...(wait_seconds === undefined ? {} : { wait_seconds }) };
}

async function readBoundedJson(request: NextRequest): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413 }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = parseInteger(contentLength, 0, Number.MAX_SAFE_INTEGER);
    if (parsed === null) return { ok: false, status: 400 };
    if (parsed > MAX_REQUEST_BODY_BYTES) return { ok: false, status: 413 };
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
  } catch {
    return { ok: false, status: 400 };
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(body)) };
  } catch {
    return { ok: false, status: 400 };
  }
}

function parsePostBody(value: unknown): { body: string; reply_to_id?: string; idempotency_key: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.every((key) => key === "body" || key === "reply_to_id" || key === "idempotency_key")) return null;
  if (typeof record.body !== "string" || record.body.length === 0 || record.body.length > MAX_MESSAGE_LENGTH) return null;
  if (typeof record.idempotency_key !== "string" || record.idempotency_key.length === 0 || record.idempotency_key.length > 128) return null;
  if (record.reply_to_id !== undefined && (typeof record.reply_to_id !== "string" || record.reply_to_id.length === 0 || record.reply_to_id.length > 128)) return null;
  return {
    body: record.body,
    idempotency_key: record.idempotency_key,
    ...(record.reply_to_id === undefined ? {} : { reply_to_id: record.reply_to_id }),
  };
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const query = parseQuery(request);
  if (!query) return error("invalid_query", 400);

  try {
    const runtime = getAgentNetworkRuntime();
    const authentication = await runtime.authenticateAgentSession(request, { requiredScopes: ["competitions:read", "chat:read"] });
    if (!authentication.ok) return mapAuthenticationError(authentication.error.code);

    const { id } = await params;
    if (!await runtime.getLiveCompetition(id)) return error("competition_not_found", 404);
    const result = await runtime.readCompetitionChat({ actor: authentication.actor, competition_id: id, ...query });
    if (!result.ok) return result.error.code === "forbidden" ? error("not_a_participant", 403) : error("chat_unavailable", 503);
    return NextResponse.json({ page: result.page });
  } catch {
    return error("chat_unavailable", 503);
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const runtime = getAgentNetworkRuntime();
    const authentication = await runtime.authenticateAgentSession(request, { requiredScopes: ["competitions:read", "chat:write"] });
    if (!authentication.ok) return mapAuthenticationError(authentication.error.code);

    const payload = await readBoundedJson(request);
    if (!payload.ok) return error(payload.status === 413 ? "body_too_large" : "invalid_body", payload.status);
    const body = parsePostBody(payload.value);
    if (!body) return error("invalid_body", 400);

    const { id } = await params;
    if (!await runtime.getLiveCompetition(id)) return error("competition_not_found", 404);
    const result = await runtime.postCompetitionMessage({ actor: authentication.actor, competition_id: id, ...body });
    if (!result.ok) {
      if (result.error.code === "conflict") return error("idempotency_conflict", 409);
      if (result.error.code === "rate_limited") return error("rate_limited", 429);
      return error("chat_unavailable", 503);
    }
    return NextResponse.json({ message: result.message }, { status: 201 });
  } catch {
    return error("chat_unavailable", 503);
  }
}
