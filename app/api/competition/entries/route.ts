import { NextRequest, NextResponse } from "next/server";
import { parseSubmitEntryRequest, type SubmitEntryRequest } from "@/lib/competition-entries";
import { getAgentNetworkRuntime } from "@/lib/agent-network-runtime";

const MAX_REQUEST_BODY_BYTES = 262_144;

type Runtime = ReturnType<typeof getAgentNetworkRuntime>;
type SessionActor = Extract<Awaited<ReturnType<Runtime["authenticateAgentSession"]>>, { ok: true }> ["actor"];
type EntryResult =
  | { ok: true; entry: { submission_id: string; run_id?: string; status: string } }
  | { ok: false; error: { code: string } };

// The durable entry saga is deliberately introduced independently from the
// existing session runtime. Keep the temporary seam here narrow: deployments
// without that capability fail closed, never fall back to the legacy mutable
// endpoint.
type EntryCapableRuntime = Pick<Runtime, "authenticateAgentSession"> & {
  submitCompetitionEntry?: (input: { actor: SessionActor; request: SubmitEntryRequest }) => Promise<EntryResult>;
};

function error(code: string, status: number) {
  return NextResponse.json({ error: { code } }, { status });
}

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
        return 413;
      }
      chunks.push(value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    return 400;
  } finally {
    reader.releaseLock();
  }
}

function parseBody(value: unknown): SubmitEntryRequest | null {
  try {
    return parseSubmitEntryRequest(value);
  } catch {
    return null;
  }
}

function entryFailure(code: string) {
  if (code === "competition_not_found") return error("competition_not_found", 404);
  if (code === "competition_closed") return error("competition_closed", 409);
  if (code === "idempotency_conflict") return error("idempotency_conflict", 409);
  if (code === "reconciliation_required") return error("entry_reconciliation_required", 503);
  return error("entries_unavailable", 503);
}

export async function POST(request: NextRequest) {
  try {
    const runtime = getAgentNetworkRuntime() as EntryCapableRuntime;
    const authentication = await runtime.authenticateAgentSession(request, { requiredScopes: ["competitions:write"] });
    if (!authentication.ok) return authenticationError(authentication.error.code);

    const value = await readJson(request);
    if (value === 400 || value === 413) return error(value === 413 ? "body_too_large" : "invalid_body", value);
    const body = parseBody(value);
    if (!body) return error("invalid_body", 400);

    if (!runtime.submitCompetitionEntry) return error("entries_unavailable", 503);
    const result = await runtime.submitCompetitionEntry({ actor: authentication.actor, request: body });
    if (!result.ok) return entryFailure(result.error.code);
    return NextResponse.json({ entry: result.entry }, { status: 202 });
  } catch {
    return error("entries_unavailable", 503);
  }
}
