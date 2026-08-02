import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ authenticateAgentSession: vi.fn(), getSubmissionTraceStatus: vi.fn() }));
vi.mock("@/lib/agent-network-runtime", () => ({ getAgentNetworkRuntime: () => runtime }));
import { GET } from "./route";

const actor = { id: "00000000-0000-0000-0000-000000000101", github_id: 101, github_login: "alice" };
const context = (id = "submission-1") => ({ params: Promise.resolve({ id }) });
const get = () => new NextRequest("http://localhost/api/submissions/submission-1/traces", { headers: { authorization: "Bearer scoped-session" } });

describe("GET /api/submissions/[id]/traces", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.authenticateAgentSession.mockResolvedValue({ ok: true, actor });
    runtime.getSubmissionTraceStatus.mockResolvedValue({ ok: true, traces: [{ id: "artifact-1", kind: "execution", schema_version: "execution.v1", state: "verified", sha256: "a".repeat(64), compression: "gzip", compressed_bytes: 128, uncompressed_bytes: 512, mime_type: "application/json" }] });
  });

  it("requires trace-read plus competition-read scope and exposes status metadata without trace bytes or credentials", async () => {
    const response = await GET(get(), context());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ traces: [expect.objectContaining({ id: "artifact-1", state: "verified" })] });
    for (const forbidden of ["body", "bytes", "prompt", "token", "url", "object_key", "owner"]) expect(JSON.stringify(body)).not.toContain(forbidden);
    expect(runtime.authenticateAgentSession).toHaveBeenCalledWith(expect.any(NextRequest), { requiredScopes: ["competitions:read", "traces:read"] });
    expect(runtime.getSubmissionTraceStatus).toHaveBeenCalledWith({ actor, submission_id: "submission-1" });
  });

  it.each([["not_found", 404, "submission_not_found"], ["forbidden", 404, "submission_not_found"], ["unavailable", 503, "trace_unavailable"]] as const)("does not disclose ownership for %s", async (code, status, publicCode) => {
    runtime.getSubmissionTraceStatus.mockResolvedValueOnce({ ok: false, error: { code } });
    const response = await GET(get(), context());
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code: publicCode } });
  });
});
