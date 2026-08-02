import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ authenticateAgentSession: vi.fn(), finalizeSubmissionTrace: vi.fn() }));
vi.mock("@/lib/agent-network-runtime", () => ({ getAgentNetworkRuntime: () => runtime }));
import { POST } from "./route";

const actor = { id: "00000000-0000-0000-0000-000000000101", github_id: 101, github_login: "alice" };
const sha256 = "a".repeat(64);
const context = (id = "artifact-1") => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) => new NextRequest("http://localhost/api/submission-artifacts/artifact-1/finalize", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer scoped-session" }, body: JSON.stringify(body) });

describe("POST /api/submission-artifacts/[id]/finalize", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.authenticateAgentSession.mockResolvedValue({ ok: true, actor });
    runtime.finalizeSubmissionTrace.mockResolvedValue({ ok: true, artifact: { id: "artifact-1", submission_id: "submission-1", state: "verified", sha256, kind: "execution", schema_version: "execution.v1" } });
  });

  it("requires trace-write plus competition-read scope and finalizes only a safe artifact DTO", async () => {
    const response = await POST(post({ sha256 }), context());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ artifact: expect.objectContaining({ id: "artifact-1", state: "verified", sha256 }) });
    for (const forbidden of ["object_key", "token", "url", "owner", "prompt", "bytes"]) expect(JSON.stringify(body)).not.toContain(forbidden);
    expect(runtime.authenticateAgentSession).toHaveBeenCalledWith(expect.any(NextRequest), { requiredScopes: ["competitions:read", "traces:write"] });
    expect(runtime.finalizeSubmissionTrace).toHaveBeenCalledWith({ actor, artifact_id: "artifact-1", sha256 });
  });

  it.each([{ sha256: "not-a-checksum" }, { sha256, extra: true }, {}])("rejects strict invalid checksum input", async (body) => {
    const response = await POST(post(body), context());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "invalid_body" } });
    expect(runtime.finalizeSubmissionTrace).not.toHaveBeenCalled();
  });

  it.each([["not_found", 404, "artifact_not_found"], ["invalid_state", 409, "invalid_artifact_state"], ["conflict", 409, "checksum_conflict"], ["unavailable", 503, "trace_unavailable"]] as const)("maps %s without logging checksum or private state", async (code, status, publicCode) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runtime.finalizeSubmissionTrace.mockResolvedValueOnce({ ok: false, error: { code } });
    const response = await POST(post({ sha256 }), context());
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code: publicCode } });
    expect(log.mock.calls.flat().join(" ")).not.toContain(sha256);
    log.mockRestore();
  });
});
