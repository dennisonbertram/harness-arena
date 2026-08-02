type DueArtifact = {
  id: string; submission_id: string; state: "pending_upload" | "uploaded"; object_key: string; sha256: string;
  compressed_bytes: number; uncompressed_bytes: number; compression: "none" | "gzip"; kind: "execution" | "rationale";
};
type Dependencies = {
  repo: {
    reconcileDue(input: { before: Date }): Promise<DueArtifact[]>;
    settleReconciliation(input: { artifact_id: string; state: "pending_upload" | "verified" | "rejected"; reason?: string; verified_sha256?: string }): Promise<unknown>;
    withSubmissionLock<T>(submissionId: string, work: () => Promise<T>): Promise<T>;
    closeSubmission(input: { submission_id: string; artifact_shas: string[] }): Promise<unknown>;
    eligibleVerifiedArtifacts(input: { submission_id: string }): Promise<Array<{ id: string; sha256: string; state: string; immutable: boolean }>>;
  };
  blob: { readVerified(input: { object_key: string; sha256: string; max_bytes: number }): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: { code: string } }> };
  policy: { verify(input: { kind: "execution" | "rationale"; compression: "none" | "gzip"; sha256: string; uncompressed_bytes: number; bytes: Buffer }): Promise<{ ok: true; verified_sha256: string } | { ok: false; disposition: string; error: { code: string } }> };
};

export function createEntrantTraceReconciler(deps: Dependencies) {
  return {
    async reconcileDue({ before }: { before: Date }) {
      const rows = await deps.repo.reconcileDue({ before });
      for (const artifact of rows) {
        const blob = await deps.blob.readVerified({ object_key: artifact.object_key, sha256: artifact.sha256, max_bytes: artifact.compressed_bytes });
        if (!blob.ok) {
          const missing = blob.error.code === "not_found";
          await deps.repo.settleReconciliation({
            artifact_id: artifact.id,
            state: missing && artifact.state === "pending_upload" ? "pending_upload" : "rejected",
            reason: missing && artifact.state === "pending_upload" ? "blob_missing_retry" : missing ? "blob_missing" : "checksum_mismatch",
          });
          continue;
        }
        const policy = await deps.policy.verify({ kind: artifact.kind, compression: artifact.compression, sha256: artifact.sha256, uncompressed_bytes: artifact.uncompressed_bytes, bytes: blob.bytes });
        await deps.repo.settleReconciliation(policy.ok
          ? { artifact_id: artifact.id, state: "verified", verified_sha256: policy.verified_sha256 }
          : { artifact_id: artifact.id, state: policy.disposition === "manual_review" ? "pending_upload" : "rejected", reason: policy.error.code });
      }
      return { processed: rows.length };
    },

    async closeSubmission({ submission_id }: { submission_id: string }) {
      return deps.repo.withSubmissionLock(submission_id, async () => {
        const artifacts = await deps.repo.eligibleVerifiedArtifacts({ submission_id });
        if (artifacts.length === 0 || artifacts.some((artifact) => artifact.state !== "verified" || !artifact.immutable)) {
          return { ok: false as const, error: { code: "traces_not_eligible" as const } };
        }
        return deps.repo.closeSubmission({ submission_id, artifact_shas: artifacts.map((artifact) => artifact.sha256) });
      });
    },
  };
}
