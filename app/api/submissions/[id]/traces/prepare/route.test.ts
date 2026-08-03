import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  authenticateAgentSession: vi.fn(),
  prepareSubmissionTrace: vi.fn(),
}));

vi.mock("@/lib/agent-network-runtime", () => ({ getAgentNetworkRuntime: () => runtime }));

import { POST } from "./route";

const actor = { id: "00000000-0000-0000-0000-000000000101", github_id: 101, github_login: "alice" };
const sha = "a".repeat(64);
const manifest = {
  schema_version: "trace-manifest.v1",
  submission_id: "submission-1",
  artifacts: [
    { kind: "execution", schema_version: "execution.v1", mime_type: "application/json", compression: "gzip", compressed_bytes: 128, uncompressed_bytes: 512, sha256: sha },
    { kind: "rationale", schema_version: "rationale.v1", mime_type: "application/json", compression: "none", compressed_bytes: 64, uncompressed_bytes: 64, sha256: "b".repeat(64) },
  ],
};
const context = (id = "submission-1") => ({ params: Promise.resolve({ id }) });
const post = (body: unknown, headers: HeadersInit = { "content-type": "application/json", authorization: "Bearer scoped-session" }) =>
  new NextRequest("http://localhost/api/submissions/submission-1/traces/prepare", { method: "POST", headers, body: JSON.stringify(body) });

describe("POST /api/submissions/[id]/traces/prepare", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.authenticateAgentSession.mockResolvedValue({ ok: true, actor });
    runtime.prepareSubmissionTrace.mockResolvedValue({
      ok: true,
      artifacts: [
        {
          artifact: { id: "artifact-1", submission_id: "submission-1", kind: "execution", schema_version: "execution.v1", state: "pending_upload", sha256: sha, compression: "gzip", compressed_bytes: 128, uncompressed_bytes: 512, mime_type: "application/json" },
          upload: { method: "PUT", url: "https://private-upload.example/execution", headers: { "content-type": "application/gzip" } },
        },
        {
          artifact: { id: "artifact-2", submission_id: "submission-1", kind: "rationale", schema_version: "rationale.v1", state: "pending_upload", sha256: "b".repeat(64), compression: "none", compressed_bytes: 64, uncompressed_bytes: 64, mime_type: "application/json" },
          upload: { method: "PUT", url: "https://private-upload.example/rationale", headers: { "content-type": "application/json" } },
        },
      ],
    });
  });

  it("requires trace-write plus competition-read scope, validates the exact v1 manifest, and returns private upload instructions only", async () => {
    const response = await POST(post({ manifest, idempotency_key: "prepare-1" }), context());

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      artifacts: [
        { artifact: { id: "artifact-1", state: "pending_upload" }, upload: { method: "PUT", url: "https://private-upload.example/execution" } },
        { artifact: { id: "artifact-2", state: "pending_upload" }, upload: { method: "PUT", url: "https://private-upload.example/rationale" } },
      ],
    });
    expect(body.artifacts).toHaveLength(2);
    for (const forbidden of ["object_key", "token", "public_url", "owner_id", "owner_entrant_id"]) expect(JSON.stringify(body)).not.toContain(forbidden);
    expect(runtime.authenticateAgentSession).toHaveBeenCalledWith(expect.any(NextRequest), { requiredScopes: ["competitions:read", "traces:write"] });
    expect(runtime.prepareSubmissionTrace).toHaveBeenCalledWith({ actor, submission_id: "submission-1", manifest, idempotency_key: "prepare-1" });
  });

  it.each([
    [{ manifest: { ...manifest, artifacts: [manifest.artifacts[0]] }, idempotency_key: "one-kind"}],
    [{ manifest: { ...manifest, artifacts: [{ ...manifest.artifacts[0], prompt: "SECRET-PROMPT" }, manifest.artifacts[1]] }, idempotency_key: "secret" }],
    [{ manifest: { ...manifest, submission_id: "other" }, idempotency_key: "wrong-submission" }],
    [{ manifest, idempotency_key: "" }],
    [{ manifest, idempotency_key: "x".repeat(257) }],
    [{ manifest, idempotency_key: "prepare-1", extra: true }],
  ])("rejects malformed, mismatched, or non-strict metadata before the facade", async (body) => {
    const response = await POST(post(body), context());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "invalid_body" } });
    expect(runtime.prepareSubmissionTrace).not.toHaveBeenCalled();
  });

  it("is owner-private, idempotent, bounded to 1 MiB, and never logs untrusted trace metadata", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runtime.prepareSubmissionTrace.mockResolvedValueOnce({ ok: false, error: { code: "not_found" } });
    const missing = await POST(post({ manifest, idempotency_key: "missing" }), context());
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: { code: "submission_not_found" } });

    runtime.prepareSubmissionTrace.mockResolvedValueOnce({ ok: false, error: { code: "conflict" } });
    const conflict = await POST(post({ manifest, idempotency_key: "prepare-1" }), context());
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: { code: "idempotency_conflict" } });

    const marker = `NEVER-LOG-${"x".repeat(1_048_576)}`;
    const oversized = new NextRequest("http://localhost/api/submissions/submission-1/traces/prepare", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer scoped-session", "content-length": String(marker.length + 128) }, body: JSON.stringify({ manifest: { ...manifest, artifacts: [{ ...manifest.artifacts[0], note: marker }, manifest.artifacts[1]] }, idempotency_key: "large" }) });
    const tooLarge = await POST(oversized, context());
    expect(tooLarge.status).toBe(413);
    expect(log.mock.calls.flat().join(" ")).not.toContain("NEVER-LOG-");
    log.mockRestore();
  });

  it.each([
    ["unauthenticated", 401, "unauthenticated"],
    ["session_unavailable", 503, "session_unavailable"],
    ["insufficient_scope", 403, "insufficient_scope"],
  ])("fails closed before parsing or preparing when authentication is %s", async (code, status, publicCode) => {
    runtime.authenticateAgentSession.mockResolvedValueOnce({ ok: false, error: { code } });
    const response = await POST(post({ manifest, idempotency_key: "prepare-auth" }), context());
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code: publicCode } });
    expect(runtime.prepareSubmissionTrace).not.toHaveBeenCalled();
  });

  it("contains runtime failures and invalid route identifiers", async () => {
    runtime.prepareSubmissionTrace.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(POST(post({ manifest, idempotency_key: "prepare-failure" }), context()))
      .resolves.toMatchObject({ status: 503 });
    await expect(POST(post({ manifest, idempotency_key: "prepare-empty" }), context("")))
      .resolves.toMatchObject({ status: 400 });
  });
});
