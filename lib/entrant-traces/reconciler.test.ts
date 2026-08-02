import { describe, expect, it, vi } from "vitest";
import { createEntrantTraceReconciler } from "./reconciler";

const SHA = "a".repeat(64);
const due = (state: "pending_upload" | "uploaded", id = "artifact-1") => ({
  id, submission_id: "sub-1", state, object_key: "private/artifacts/00000000-0000-0000-0000-000000000400",
  sha256: SHA, compressed_bytes: 12, uncompressed_bytes: 20, compression: "none", kind: "execution",
});

function dependencies(rows = [due("uploaded")]) {
  return {
    repo: {
      reconcileDue: vi.fn().mockResolvedValue(rows),
      settleReconciliation: vi.fn().mockResolvedValue({ ok: true }),
      withSubmissionLock: vi.fn(async (_submissionId, work) => work()),
      closeSubmission: vi.fn().mockResolvedValue({ ok: true }),
      eligibleVerifiedArtifacts: vi.fn().mockResolvedValue([{ id: "artifact-1", sha256: SHA, state: "verified", immutable: true }]),
    },
    blob: { readVerified: vi.fn().mockResolvedValue({ ok: true, bytes: Buffer.from("{}") }) },
    policy: { verify: vi.fn().mockResolvedValue({ ok: true, verified_sha256: SHA }) },
  };
}

describe("entrant trace reconciliation boundary", () => {
  it("reconciles both pending_upload and uploaded rows, retaining pending missing objects but rejecting an uploaded missing/checksum-mismatched object", async () => {
    const deps = dependencies([due("pending_upload", "pending"), due("uploaded", "missing"), due("uploaded", "bad-sha")]);
    deps.blob.readVerified
      .mockResolvedValueOnce({ ok: false, error: { code: "not_found" } })
      .mockResolvedValueOnce({ ok: false, error: { code: "not_found" } })
      .mockResolvedValueOnce({ ok: false, error: { code: "checksum_mismatch" } });
    const reconciler = createEntrantTraceReconciler(deps);

    await expect(reconciler.reconcileDue({ before: new Date("2026-08-03T00:00:00.000Z") })).resolves.toEqual({ processed: 3 });
    expect(deps.repo.settleReconciliation).toHaveBeenNthCalledWith(1, { artifact_id: "pending", state: "pending_upload", reason: "blob_missing_retry" });
    expect(deps.repo.settleReconciliation).toHaveBeenNthCalledWith(2, { artifact_id: "missing", state: "rejected", reason: "blob_missing" });
    expect(deps.repo.settleReconciliation).toHaveBeenNthCalledWith(3, { artifact_id: "bad-sha", state: "rejected", reason: "checksum_mismatch" });
  });

  it("is idempotent across a database crash after the immutable blob was verified", async () => {
    const deps = dependencies();
    deps.repo.settleReconciliation.mockRejectedValueOnce(new Error("database crash")).mockResolvedValueOnce({ ok: true, already_settled: true });
    const reconciler = createEntrantTraceReconciler(deps);

    await expect(reconciler.reconcileDue({ before: new Date() })).rejects.toThrow("database crash");
    await expect(reconciler.reconcileDue({ before: new Date() })).resolves.toEqual({ processed: 1 });
    expect(deps.blob.readVerified).toHaveBeenCalledTimes(2);
    expect(deps.policy.verify).toHaveBeenCalledTimes(2);
    expect(deps.repo.settleReconciliation).toHaveBeenLastCalledWith({ artifact_id: "artifact-1", state: "verified", verified_sha256: SHA });
  });

  it("serializes close against finalize and makes eligibility depend only on policy-verified immutable SHA rows", async () => {
    const deps = dependencies();
    const reconciler = createEntrantTraceReconciler(deps);

    await expect(reconciler.closeSubmission({ submission_id: "sub-1" })).resolves.toEqual({ ok: true });
    expect(deps.repo.withSubmissionLock).toHaveBeenCalledWith("sub-1", expect.any(Function));
    expect(deps.repo.eligibleVerifiedArtifacts).toHaveBeenCalledWith({ submission_id: "sub-1" });
    expect(deps.repo.closeSubmission).toHaveBeenCalledWith({ submission_id: "sub-1", artifact_shas: [SHA] });

    deps.repo.eligibleVerifiedArtifacts.mockResolvedValueOnce([{ id: "artifact-1", sha256: SHA, state: "uploaded", immutable: false }]);
    await expect(reconciler.closeSubmission({ submission_id: "sub-1" })).resolves.toEqual({ ok: false, error: { code: "traces_not_eligible" } });
    expect(deps.repo.closeSubmission).toHaveBeenCalledTimes(1);
  });
});
