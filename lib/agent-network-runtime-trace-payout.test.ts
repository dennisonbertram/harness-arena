import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createAgentNetworkRuntime } from "./agent-network-runtime";

const NOW = new Date("2026-08-03T12:00:00.000Z");
const ALICE = {
  id: "00000000-0000-0000-0000-000000000101",
  github_id: 101,
  github_login: "alice",
  authenticated_at: NOW.toISOString(),
  session_id: "00000000-0000-0000-0000-000000000501",
};
const BOB = { ...ALICE, id: "00000000-0000-0000-0000-000000000202", github_id: 202, github_login: "bob" };
const EXECUTION_BYTES = Buffer.from("execution trace");
const RATIONALE_BYTES = Buffer.from("rationale trace");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const manifest = {
  schema_version: "trace-manifest.v1",
  submission_id: "submission-1",
  artifacts: [
    { kind: "execution", schema_version: "execution.v1", mime_type: "application/json", compression: "gzip", compressed_bytes: EXECUTION_BYTES.length, uncompressed_bytes: 32, sha256: sha256(EXECUTION_BYTES) },
    { kind: "rationale", schema_version: "rationale.v1", mime_type: "application/json", compression: "none", compressed_bytes: RATIONALE_BYTES.length, uncompressed_bytes: RATIONALE_BYTES.length, sha256: sha256(RATIONALE_BYTES) },
  ],
};

function fixture() {
  const records = new Map<string, any>();
  const traces = {
    prepare: vi.fn(async ({ actor, operation_id, artifact }) => {
      if (actor?.id !== ALICE.id || artifact.submission_id !== "submission-1") return { ok: false, error: { code: "not_found" } };
      const prior = records.get(operation_id);
      if (prior) return { ok: true, artifact: prior };
      const artifactRecord = {
        id: `artifact-${artifact.kind}`,
        submission_id: artifact.submission_id,
        owner_entrant_id: actor.id,
        object_key: `private/artifacts/00000000-0000-0000-0000-0000000000${artifact.kind === "execution" ? "11" : "22"}`,
        ...artifact,
        state: "pending_upload",
      };
      records.set(operation_id, artifactRecord);
      return { ok: true, artifact: artifactRecord };
    }),
    getInternalForOwner: vi.fn(async ({ actor, artifact_id }) => {
      const artifact = [...records.values()].find((value) => value.id === artifact_id);
      return artifact && artifact.owner_entrant_id === actor?.id
        ? { ok: true, artifact }
        : { ok: false, error: { code: "not_found" } };
    }),
    recordUpload: vi.fn(async ({ actor, artifact_id, sha256: checksum, compressed_bytes }) => {
      const artifact = [...records.values()].find((value) => value.id === artifact_id);
      if (!artifact || artifact.owner_entrant_id !== actor?.id) return { ok: false, error: { code: "not_found" } };
      if (artifact.sha256 !== checksum || artifact.compressed_bytes !== compressed_bytes) return { ok: false, error: { code: "checksum_mismatch" } };
      artifact.state = "uploaded";
      return { ok: true, artifact };
    }),
    finalize: vi.fn(async ({ actor, artifact_id, sha256: checksum }) => {
      const artifact = [...records.values()].find((value) => value.id === artifact_id);
      if (!artifact || artifact.owner_entrant_id !== actor?.id) return { ok: false, error: { code: "not_found" } };
      if (artifact.state !== "uploaded" || artifact.sha256 !== checksum) return { ok: false, error: { code: "invalid_state" } };
      artifact.state = "verified";
      return { ok: true, artifact };
    }),
    listForOwner: vi.fn(async ({ actor, submission_id }) => ({
      ok: true,
      traces: [...records.values()].filter((value) => value.owner_entrant_id === actor?.id && value.submission_id === submission_id),
    })),
  };
  const privateBlob = {
    prepareUpload: vi.fn(async ({ object_key, compression, compressed_bytes }) => ({
      upload_url: `https://private-upload.example/${object_key.split("/").at(-1)}`,
      expires_at: NOW.getTime() + 600_000,
      // The fake deliberately receives internal metadata; the runtime must not return it.
      compression,
      compressed_bytes,
    })),
    readVerified: vi.fn(async ({ object_key, sha256: checksum, max_bytes }) => {
      const bytes = object_key.endsWith("11") ? EXECUTION_BYTES : RATIONALE_BYTES;
      if (bytes.length > max_bytes || sha256(bytes) !== checksum) return { ok: false, error: { code: "checksum_mismatch" } };
      return { ok: true, bytes };
    }),
  };
  const payouts = {
    prepare: vi.fn(async ({ actor, address, reauthenticated_at }) => ({
      ok: true,
      challenge: { id: "challenge-1", address, chain_id: 1, message: "signed public challenge", expires_at: NOW.toISOString(), actor_id: actor.id, reauthenticated_at },
    })),
    verify: vi.fn(async () => ({ ok: true, profile: { provider: "external", address: "0x000000000000000000000000000000000000dEaD", chain_id: 1, verification_method: "eip191", consent_version: "payout-address.v1", verified_at: NOW.toISOString(), change_effective_at: NOW.toISOString(), effective: true } })),
    getProfile: vi.fn(async () => ({ ok: true, profile: null })),
  };
  const baseServices = {
    repositories: {
      entrants: { upsert: vi.fn() },
      sessions: { create: vi.fn(), isAuthenticated: vi.fn(), touch: vi.fn() },
      memberships: { set: vi.fn() },
    },
    chat: { list: vi.fn(), post: vi.fn() },
  };
  const storage = { getCompetition: vi.fn(), getSubmission: vi.fn(async (id: string) => id === "submission-1" ? { id, entrant_id: ALICE.id } : undefined) };
  const runtime = (createAgentNetworkRuntime as any)({
    services: { ...baseServices, traces, payouts },
    storage,
    privateBlob,
    now: () => NOW,
    tokenConfiguration: { issuer: "harness-arena", audience: "harness-arena-mcp", keyId: "key-1" },
  });
  return { runtime, traces, privateBlob, payouts, storage, records };
}

describe("agent network runtime trace and payout orchestration", () => {
  it("prepares exactly execution and rationale artifacts with stable operation ids, private uploads, and safe replay DTOs", async () => {
    const { runtime, traces, privateBlob } = fixture();

    const first = await runtime.prepareSubmissionTrace({ actor: ALICE, submission_id: "submission-1", manifest, idempotency_key: "prepare-1" });
    const second = await runtime.prepareSubmissionTrace({ actor: ALICE, submission_id: "submission-1", manifest, idempotency_key: "prepare-1" });

    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true, artifacts: [
      { artifact: { id: "artifact-execution", kind: "execution", state: "pending_upload" }, upload: { method: "PUT", url: expect.stringContaining("private-upload.example") } },
      { artifact: { id: "artifact-rationale", kind: "rationale", state: "pending_upload" }, upload: { method: "PUT", url: expect.stringContaining("private-upload.example") } },
    ] });
    expect(traces.prepare).toHaveBeenCalledTimes(4);
    const operationIds = traces.prepare.mock.calls.map(([input]: [any]) => input.operation_id);
    expect(new Set(operationIds.slice(0, 2)).size).toBe(2);
    expect(operationIds.slice(2)).toEqual(operationIds.slice(0, 2));
    expect(privateBlob.prepareUpload).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(first)).not.toMatch(/object_key|owner_entrant_id|private-read-token|private-write-token/i);
  });

  it("rejects foreign ownership and a manifest not bound to the requested submission before durable writes", async () => {
    const { runtime, traces, privateBlob } = fixture();

    await expect(runtime.prepareSubmissionTrace({ actor: BOB, submission_id: "submission-1", manifest, idempotency_key: "foreign" })).resolves.toMatchObject({ ok: false });
    await expect(runtime.prepareSubmissionTrace({ actor: ALICE, submission_id: "submission-1", manifest: { ...manifest, submission_id: "submission-2" }, idempotency_key: "mismatch" })).resolves.toMatchObject({ ok: false });

    expect(traces.prepare).not.toHaveBeenCalled();
    expect(privateBlob.prepareUpload).not.toHaveBeenCalled();
  });

  it("recovers a partial prepare replay using the same per-artifact operation ids", async () => {
    const { runtime, traces } = fixture();
    traces.prepare.mockImplementationOnce(async ({ operation_id, artifact }: any) => ({ ok: true, artifact: { id: "artifact-execution", submission_id: "submission-1", owner_entrant_id: ALICE.id, object_key: "private/artifacts/00000000-0000-0000-0000-000000000011", ...artifact, state: "pending_upload", operation_id } }));
    traces.prepare.mockRejectedValueOnce(new Error("transient database failure after execution record"));

    await expect(runtime.prepareSubmissionTrace({ actor: ALICE, submission_id: "submission-1", manifest, idempotency_key: "partial-1" })).rejects.toThrow("transient database failure");
    const recovered = await runtime.prepareSubmissionTrace({ actor: ALICE, submission_id: "submission-1", manifest, idempotency_key: "partial-1" });

    expect(recovered).toMatchObject({ ok: true, artifacts: expect.arrayContaining([expect.objectContaining({ artifact: expect.objectContaining({ kind: "execution" }) }), expect.objectContaining({ artifact: expect.objectContaining({ kind: "rationale" }) })]) });
    const operationIds = traces.prepare.mock.calls.map(([input]: [any]) => input.operation_id);
    expect(operationIds[2]).toBe(operationIds[0]);
    expect(operationIds[3]).toBe(operationIds[1]);
  });

  it("owner-checks internal trace metadata before a bounded private checksum read and only then records and finalizes", async () => {
    const { runtime, traces, privateBlob } = fixture();
    await runtime.prepareSubmissionTrace({ actor: ALICE, submission_id: "submission-1", manifest, idempotency_key: "finalize-prepare" });

    const result = await runtime.finalizeSubmissionTrace({ actor: ALICE, artifact_id: "artifact-execution", sha256: manifest.artifacts[0].sha256 });

    expect(privateBlob.readVerified).toHaveBeenCalledWith({ object_key: expect.stringMatching(/^private\/artifacts\//), sha256: manifest.artifacts[0].sha256, max_bytes: EXECUTION_BYTES.length });
    expect(traces.recordUpload).toHaveBeenCalledWith({ actor: ALICE, artifact_id: "artifact-execution", sha256: manifest.artifacts[0].sha256, compressed_bytes: EXECUTION_BYTES.length });
    expect(traces.finalize).toHaveBeenCalledWith({ actor: ALICE, artifact_id: "artifact-execution", sha256: manifest.artifacts[0].sha256 });
    expect(result).toMatchObject({ ok: true, artifact: { id: "artifact-execution", state: "verified" } });
    expect(JSON.stringify(result)).not.toMatch(/object_key|owner_entrant_id|token/i);
  });

  it("returns not_found for a foreign artifact without attempting a private Blob read", async () => {
    const { runtime, privateBlob, traces } = fixture();
    await runtime.prepareSubmissionTrace({ actor: ALICE, submission_id: "submission-1", manifest, idempotency_key: "foreign-finalize" });

    await expect(runtime.finalizeSubmissionTrace({ actor: BOB, artifact_id: "artifact-execution", sha256: manifest.artifacts[0].sha256 })).resolves.toEqual({ ok: false, error: { code: "not_found" } });

    expect(privateBlob.readVerified).not.toHaveBeenCalled();
    expect(traces.recordUpload).not.toHaveBeenCalled();
    expect(traces.finalize).not.toHaveBeenCalled();
  });

  it("lists only the caller's safe trace status records", async () => {
    const { runtime } = fixture();
    await runtime.prepareSubmissionTrace({ actor: ALICE, submission_id: "submission-1", manifest, idempotency_key: "status-prepare" });

    const result = await runtime.getSubmissionTraceStatus({ actor: ALICE, submission_id: "submission-1" });

    expect(result).toMatchObject({ ok: true, traces: [{ id: "artifact-execution" }, { id: "artifact-rationale" }] });
    expect(JSON.stringify(result)).not.toMatch(/object_key|owner_entrant_id|token/i);
  });

  it("derives payout challenge reauthentication only from the signed actor and delegates verify/profile without payment authority", async () => {
    const { runtime, payouts, privateBlob } = fixture();

    const challenge = await runtime.prepareExternalPayoutAddress({ actor: ALICE, address: "0x000000000000000000000000000000000000dEaD" });
    const verified = await runtime.verifyExternalPayoutAddress({ actor: ALICE, challenge_id: "challenge-1", signature: "0xsigned", consent_version: "payout-address.v1", idempotency_key: "verify-1" });
    const profile = await runtime.getPayoutProfile({ actor: ALICE });

    expect(payouts.prepare).toHaveBeenCalledWith({ actor: { id: ALICE.id }, address: "0x000000000000000000000000000000000000dEaD", reauthenticated_at: ALICE.authenticated_at });
    expect(payouts.verify).toHaveBeenCalledWith({ actor: { id: ALICE.id }, challenge_id: "challenge-1", signature: "0xsigned", consent_version: "payout-address.v1", idempotency_key: "verify-1" });
    expect(payouts.getProfile).toHaveBeenCalledWith({ actor: { id: ALICE.id } });
    expect(challenge).toMatchObject({ ok: true, challenge: { id: "challenge-1" } });
    expect(verified).toMatchObject({ ok: true, profile: { provider: "external" } });
    expect(profile).toEqual({ ok: true, profile: null });
    expect(privateBlob.readVerified).not.toHaveBeenCalled();
  });
});
