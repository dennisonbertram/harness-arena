import { describe, expect, it, vi } from "vitest";
import { HarnessArenaClient } from "./client.js";
import { toolDefinitions } from "./server.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const credentials = () => ({ get: vi.fn().mockResolvedValue({ token: "arena-session", github_login: "octo", expires_at: "2030-01-01T00:00:00Z" }), set: vi.fn() });
const sha = "a".repeat(64);
const manifest = { schema_version: "trace-manifest.v1", submission_id: "submission/one", artifacts: [
  { kind: "execution", schema_version: "execution.v1", mime_type: "application/json", compression: "gzip", compressed_bytes: 128, uncompressed_bytes: 512, sha256: sha },
  { kind: "rationale", schema_version: "rationale.v1", mime_type: "application/json", compression: "none", compressed_bytes: 64, uncompressed_bytes: 64, sha256: "b".repeat(64) },
] };

describe("private submission trace MCP tools", () => {
  it("uses exact authenticated private trace routes", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(201, { artifact: { id: "artifact-1" }, upload: { method: "PUT", url: "https://private.example/upload" } })).mockResolvedValueOnce(json(200, { artifact: { id: "artifact-1", state: "verified" } })).mockResolvedValueOnce(json(200, { traces: [] }));
    const client = new HarnessArenaClient({ baseUrl: "https://arena.example.test/base?ignored=yes", credentials: credentials(), fetch: fetcher });
    await client.prepareSubmissionTrace({ submission_id: "submission/one", manifest, idempotency_key: "prepare-1" });
    await client.finalizeSubmissionTrace({ artifact_id: "artifact/one", sha256: sha });
    await client.getSubmissionTraceStatus({ submission_id: "submission/one" });
    expect(fetcher.mock.calls.map(([url]) => url.toString())).toEqual([
      "https://arena.example.test/api/submissions/submission%2Fone/traces/prepare",
      "https://arena.example.test/api/submission-artifacts/artifact%2Fone/finalize",
      "https://arena.example.test/api/submissions/submission%2Fone/traces",
    ]);
    for (const [, options] of fetcher.mock.calls) expect(options.headers).toMatchObject({ Authorization: "Bearer arena-session" });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ manifest, idempotency_key: "prepare-1" }) });
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify({ sha256: sha }) });
  });

  it("defines strict bounded untrusted-evidence tools and delegates their exact inputs", async () => {
    const client = { prepareSubmissionTrace: vi.fn(), finalizeSubmissionTrace: vi.fn(), getSubmissionTraceStatus: vi.fn() };
    const definitions = toolDefinitions(client as never);
    const prepare = definitions.prepare_submission_trace;
    const finalize = definitions.finalize_submission_trace;
    const status = definitions.get_submission_trace_status;
    expect(prepare.inputSchema.safeParse({ submission_id: "submission-1", manifest, idempotency_key: "prepare-1" }).success).toBe(true);
    expect(prepare.inputSchema.safeParse({ submission_id: "submission-1", manifest: { ...manifest, artifacts: [manifest.artifacts[0]] }, idempotency_key: "prepare-1" }).success).toBe(false);
    expect(prepare.inputSchema.safeParse({ submission_id: "submission-1", manifest, idempotency_key: "x".repeat(257) }).success).toBe(false);
    expect(prepare.inputSchema.safeParse({ submission_id: "submission-1", manifest, idempotency_key: "prepare-1", extra: true }).success).toBe(false);
    expect(finalize.inputSchema.safeParse({ artifact_id: "artifact-1", sha256: sha }).success).toBe(true);
    expect(finalize.inputSchema.safeParse({ artifact_id: "artifact-1", sha256: "bad" }).success).toBe(false);
    expect(status.inputSchema.safeParse({ submission_id: "submission-1" }).success).toBe(true);
    expect(status.inputSchema.safeParse({ submission_id: "x".repeat(257) }).success).toBe(false);
    expect(prepare.description).toMatch(/untrusted/i);
    expect(finalize.description).toMatch(/untrusted/i);
    expect(status.description).toMatch(/untrusted/i);
    await prepare.handler({ submission_id: "submission-1", manifest, idempotency_key: "prepare-1" });
    await finalize.handler({ artifact_id: "artifact-1", sha256: sha });
    await status.handler({ submission_id: "submission-1" });
    expect(client.prepareSubmissionTrace).toHaveBeenCalledWith({ submission_id: "submission-1", manifest, idempotency_key: "prepare-1" });
    expect(client.finalizeSubmissionTrace).toHaveBeenCalledWith({ artifact_id: "artifact-1", sha256: sha });
    expect(client.getSubmissionTraceStatus).toHaveBeenCalledWith({ submission_id: "submission-1" });
  });
});
