import { createHash } from "node:crypto";

type Sql = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };
type Db = Sql & { transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> };
type Actor = { id: string; github_id: number; github_login: string };
type Artifact = { submission_id: string; kind: string; schema_version: string; mime_type: string; compression: string; compressed_bytes: number; uncompressed_bytes: number; sha256: string; consent: string };
type Failure = { ok: false; error: { code: "unauthenticated" | "not_found" | "conflict" | "invalid_state" | "policy_required" } };
type VerifiedPolicy = { verified_sha256: string; scan_revision: string };
const fail = (code: Failure["error"]["code"]): Failure => ({ ok: false, error: { code } });
const canonical = (value: any): string => value && typeof value === "object" && !Array.isArray(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const deterministicUuid = (value: string) => {
  const bytes = createHash("sha256").update(value).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export function createPostgresEntrantTraces(db: Db, options: { ids: { next(): string }; now(): Date }) {
  const tails = new Map<string, Promise<void>>();
  const safeArtifact = (artifact: any) => {
    const { object_key, owner_entrant_id, ...safe } = artifact;
    return safe;
  };
  async function read(id: string, sql: Sql = db) {
    const result = await sql.query<any>(`SELECT id, submission_id, owner_entrant_id, kind, schema_version, object_key, sha256, compression, compressed_bytes, uncompressed_bytes, mime_type, consent, state, reconcile_after, scan_state, scan_revision, policy_verified_at FROM submission_artifacts WHERE id = $1`, [id]);
    const artifact = result.rows[0];
    if (!artifact) return null;
    return Object.fromEntries(Object.entries(artifact).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
  }
  return {
    async prepare({ actor, operation_id, artifact }: { actor: Actor | null; operation_id: string; artifact: Artifact }) {
      if (!actor) return fail("unauthenticated");
      const scope = `${actor.id}\u0000${operation_id}`;
      const previous = tails.get(scope) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>((resolve) => { release = resolve; });
      const queued = previous.then(() => tail);
      tails.set(scope, queued);
      await previous;
      try {
      const request_hash = hash(artifact);
      const prior = await db.query<any>(`SELECT request_hash, entity_id, response_json FROM idempotency_operations WHERE actor_id=$1 AND competition_id IS NULL AND operation='entrant.trace.prepare' AND idempotency_key=$2`, [actor.id, operation_id]);
      if (prior.rows[0]) return prior.rows[0].request_hash === request_hash ? prior.rows[0].response_json : fail("conflict");
      try {
        return await db.transaction(async (tx) => {
        // This parent-row lock is shared with closeSubmission, so a completed
        // close snapshot cannot race a later artifact preparation in another
        // runtime.
        const owner = await tx.query<{ entrant_id: string }>(
          "SELECT entrant_id FROM submission_bindings WHERE submission_id=$1 AND entrant_id=$2 FOR UPDATE",
          [artifact.submission_id, actor.id],
        );
        if (!owner.rows[0]) return fail("not_found");
        const closed = await tx.query<{ submission_id: string }>(
          "SELECT submission_id FROM submission_trace_closures WHERE submission_id=$1",
          [artifact.submission_id],
        );
        if (closed.rows[0]) return fail("invalid_state");
        const id = options.ids.next(); const op = options.ids.next(); const now = options.now().toISOString();
        const object_key = `private/artifacts/${id}`;
        await tx.query(`INSERT INTO submission_artifacts (id,submission_id,owner_entrant_id,kind,schema_version,object_key,sha256,compression,compressed_bytes,uncompressed_bytes,mime_type,consent,state,reconcile_after,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending_upload',$13,$13,$13)`, [id,artifact.submission_id,actor.id,artifact.kind,artifact.schema_version,object_key,artifact.sha256,artifact.compression,artifact.compressed_bytes,artifact.uncompressed_bytes,artifact.mime_type,artifact.consent,now]);
        const response = { ok: true as const, artifact: await read(id, tx) };
        await tx.query(`INSERT INTO idempotency_operations (id,actor_id,competition_id,operation,idempotency_key,request_hash,entity_id,response_json,state,created_at,updated_at,completed_at) VALUES ($1,$2,NULL,'entrant.trace.prepare',$3,$4,$5,$6::jsonb,'completed',$7,$7,$7)`, [op,actor.id,operation_id,request_hash,id,JSON.stringify(response),now]);
        return response;
        });
      } catch (e) {
        const retry = await db.query<any>(`SELECT request_hash, response_json FROM idempotency_operations WHERE actor_id=$1 AND competition_id IS NULL AND operation='entrant.trace.prepare' AND idempotency_key=$2`, [actor.id, operation_id]);
        if (retry.rows[0]?.request_hash === request_hash) return retry.rows[0].response_json;
        throw e;
      }
      } finally { release(); if (tails.get(scope) === queued) tails.delete(scope); }
    },
    async recordUpload({ actor, artifact_id, sha256, compressed_bytes }: { actor: Actor | null; artifact_id: string; sha256: string; compressed_bytes: number }) {
      if (!actor) return fail("unauthenticated"); const a = await read(artifact_id); if (!a || a.owner_entrant_id !== actor.id) return fail("not_found");
      if (a.state !== "pending_upload") return fail("invalid_state");
      const now = options.now().toISOString();
      if (a.sha256 !== sha256 || Number(a.compressed_bytes) !== compressed_bytes) { await db.query("UPDATE submission_artifacts SET state='rejected', rejected_at=$3, updated_at=$3 WHERE id=$1 AND owner_entrant_id=$2 AND state='pending_upload'", [artifact_id, actor.id, now]); return { ok: false as const, error: { code: "checksum_mismatch" }, artifact: await read(artifact_id) }; }
      const updated = await db.query<{ id: string }>("UPDATE submission_artifacts SET state='uploaded', reconcile_after=$3, updated_at=$3 WHERE id=$1 AND owner_entrant_id=$2 AND state='pending_upload' RETURNING id", [artifact_id, actor.id, now]);
      if (!updated.rows[0]) return fail("invalid_state");
      return { ok: true as const, artifact: await read(artifact_id) };
    },
    async finalize({ actor, artifact_id, sha256, policy }: { actor: Actor | null; artifact_id: string; sha256: string; policy?: VerifiedPolicy }) {
      if (!actor) return fail("unauthenticated"); const a = await read(artifact_id); if (!a || a.owner_entrant_id !== actor.id) return fail("not_found");
      if (a.sha256 !== sha256) {
        if (a.state === "verified") return fail("conflict");
        await db.query("UPDATE submission_artifacts SET state='rejected', rejected_at=$2, updated_at=$2 WHERE id=$1", [artifact_id, options.now().toISOString()]);
        return fail("conflict");
      }
      if (a.state === "verified") return a.scan_state === "approved" && typeof a.scan_revision === "string"
        ? { ok: true as const, artifact: a }
        : fail("invalid_state");
      if (a.state !== "uploaded") return fail("invalid_state");
      if (!policy
        || policy.verified_sha256 !== sha256
        || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(policy.scan_revision)) return fail("policy_required");
      const now = options.now().toISOString();
      const updated = await db.query<{ id: string }>(
        `UPDATE submission_artifacts
         SET state='verified', verified_at=$3, scan_state='approved', scan_revision=$4,
             policy_verified_at=$3, updated_at=$3
         WHERE id=$1 AND owner_entrant_id=$2 AND state='uploaded' AND sha256=$5
         RETURNING id`,
        [artifact_id, actor.id, now, policy.scan_revision, sha256],
      );
      if (!updated.rows[0]) {
        const current = await read(artifact_id);
        return current?.owner_entrant_id === actor.id
          && current.state === "verified"
          && current.sha256 === sha256
          && current.scan_state === "approved"
          ? { ok: true as const, artifact: current }
          : fail("invalid_state");
      }
      return { ok: true as const, artifact: await read(artifact_id) };
    },
    async getInternalForOwner({ actor, artifact_id }: { actor: Actor | null; artifact_id: string }) {
      if (!actor) return fail("unauthenticated");
      const artifact = await read(artifact_id);
      if (!artifact || artifact.owner_entrant_id !== actor.id) return fail("not_found");
      return { ok: true as const, artifact };
    },
    async getForOwner({ actor, artifact_id }: { actor: Actor | null; artifact_id: string }) {
      if (!actor) return fail("unauthenticated");
      const artifact = await read(artifact_id);
      if (!artifact || artifact.owner_entrant_id !== actor.id) return fail("not_found");
      return { ok: true as const, artifact: safeArtifact(artifact) };
    },
    async listForOwner({ actor, submission_id }: { actor: Actor | null; submission_id: string }) {
      if (!actor) return fail("unauthenticated");
      const binding = await db.query<{ entrant_id: string }>(
        "SELECT entrant_id FROM submission_bindings WHERE submission_id = $1 AND entrant_id = $2",
        [submission_id, actor.id],
      );
      if (!binding.rows[0]) return fail("not_found");
      const result = await db.query<{ id: string }>(
        `SELECT id FROM submission_artifacts
         WHERE submission_id = $1 AND owner_entrant_id = $2
         ORDER BY kind, schema_version, id`,
        [submission_id, actor.id],
      );
      const artifacts = await Promise.all(result.rows.map((row) => read(row.id)));
      return {
        ok: true as const,
        traces: artifacts.filter((artifact) => artifact !== null).map(safeArtifact),
      };
    },
    async reconcileDue({ before }: { before: Date }) { const rows = await db.query<any>("SELECT id,submission_id,owner_entrant_id,kind,schema_version,object_key,sha256,compressed_bytes,uncompressed_bytes,mime_type,consent,state,reconcile_after FROM submission_artifacts WHERE state IN ('pending_upload','uploaded') AND reconcile_after <= $1 ORDER BY reconcile_after", [before.toISOString()]); return rows.rows; },
    /**
     * Records the result of the private Blob/policy reconciliation.  The
     * policy port deliberately exposes only a digest, so this boundary never
     * persists uploaded content or scanner diagnostics.
     */
    async settleReconciliation({ artifact_id, state, reason, verified_sha256 }: {
      artifact_id: string; state: "pending_upload" | "verified" | "rejected"; reason?: string; verified_sha256?: string;
    }) {
      const artifact = await read(artifact_id);
      if (!artifact) return fail("not_found");
      const now = options.now().toISOString();
      const safeReason = typeof reason === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(reason) ? reason : null;

      if (state === "verified") {
        // A database write is not an authorization to verify: only the exact
        // digest returned from the policy boundary can advance this state.
        if (verified_sha256 !== artifact.sha256) return fail("conflict");
        if (artifact.state === "verified") {
          return artifact.scan_state === "approved" && typeof artifact.scan_revision === "string" && artifact.scan_revision.length > 0
            ? { ok: true as const, artifact, already_settled: true }
            : fail("invalid_state");
        }
        if (artifact.state !== "uploaded") return fail("invalid_state");
        const changed = await db.query<{ id: string }>(
          `UPDATE submission_artifacts
           SET state='verified', verified_at=$2, scan_state='approved', scan_revision='trace-policy.v1',
               scan_summary=NULL, policy_verified_at=$2, updated_at=$2
           WHERE id=$1 AND state='uploaded' AND sha256=$3
           RETURNING id`,
          [artifact_id, now, verified_sha256],
        );
        if (!changed.rows[0]) return fail("invalid_state");
      } else if (state === "pending_upload") {
        // A non-terminal policy uncertainty is never treated as an approval.
        if (artifact.state !== "pending_upload" && artifact.state !== "uploaded") return fail("invalid_state");
        await db.query(
          `UPDATE submission_artifacts
           SET state='pending_upload', scan_state='manual_review', scan_revision='trace-policy.v1',
               scan_summary=$2, policy_verified_at=NULL, updated_at=$3
           WHERE id=$1 AND state IN ('pending_upload','uploaded')`,
          [artifact_id, safeReason, now],
        );
      } else {
        if (artifact.state === "verified") return fail("invalid_state");
        if (artifact.state !== "pending_upload" && artifact.state !== "uploaded" && artifact.state !== "rejected") return fail("invalid_state");
        await db.query(
          `UPDATE submission_artifacts
           SET state='rejected', rejected_at=COALESCE(rejected_at,$3), scan_state='rejected', scan_revision='trace-policy.v1',
               scan_summary=$2, policy_verified_at=NULL, updated_at=$3
           WHERE id=$1 AND state <> 'verified'`,
          [artifact_id, safeReason, now],
        );
      }
      const settled = await read(artifact_id);
      return settled ? { ok: true as const, artifact: settled } : fail("not_found");
    },
    async withSubmissionLock<T>(submissionId: string, work: () => Promise<T>): Promise<T> {
      // This queue avoids redundant close probes in one runtime. The durable
      // exclusion is the submission binding row and immutable closure written
      // transactionally by closeSubmission below.
      const previous = tails.get(`submission-close\u0000${submissionId}`) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>((resolve) => { release = resolve; });
      const queued = previous.then(() => tail);
      const key = `submission-close\u0000${submissionId}`;
      tails.set(key, queued);
      await previous;
      try { return await work(); }
      finally { release(); if (tails.get(key) === queued) tails.delete(key); }
    },
    async eligibleVerifiedArtifacts({ submission_id }: { submission_id: string }) {
      const rows = await db.query<{ id: string; sha256: string; state: string; immutable: boolean }>(
        `SELECT id, sha256, state,
                (state='verified' AND scan_state='approved' AND scan_revision IS NOT NULL
                 AND length(scan_revision) > 0 AND policy_verified_at IS NOT NULL
                 AND verified_at IS NOT NULL AND deleted_at IS NULL) AS immutable
         FROM submission_artifacts
         WHERE submission_id=$1
           AND state='verified' AND scan_state='approved' AND scan_revision IS NOT NULL
           AND length(scan_revision) > 0 AND policy_verified_at IS NOT NULL
           AND verified_at IS NOT NULL AND deleted_at IS NULL
         ORDER BY id`,
        [submission_id],
      );
      return rows.rows;
    },
    async closeSubmission({ submission_id, artifact_shas }: { submission_id: string; artifact_shas: string[] }) {
      return db.transaction(async (tx) => {
        const binding = await tx.query<{ entrant_id: string }>(
          "SELECT entrant_id FROM submission_bindings WHERE submission_id=$1 FOR UPDATE", [submission_id],
        );
        if (!binding.rows[0]) return fail("not_found");
        const all = await tx.query<{ id: string; sha256: string; state: string; scan_state: string; scan_revision: string | null; policy_verified_at: unknown; verified_at: unknown; deleted_at: unknown }>(
          `SELECT id, sha256, state, scan_state, scan_revision, policy_verified_at, verified_at, deleted_at
           FROM submission_artifacts WHERE submission_id=$1 ORDER BY id FOR UPDATE`, [submission_id],
        );
        const expected = [...new Set(artifact_shas)].sort();
        const approved = all.rows.filter((row) => row.state === "verified" && row.scan_state === "approved"
          && typeof row.scan_revision === "string" && row.scan_revision.length > 0
          && row.policy_verified_at !== null && row.policy_verified_at !== undefined
          && row.verified_at !== null && row.verified_at !== undefined && row.deleted_at == null);
        const actual = approved.map((row) => row.sha256).sort();
        // The approved projection is not enough: an uploaded/manual/rejected
        // trace for the same submission is unresolved payout evidence.
        if (all.rows.length === 0 || approved.length !== all.rows.length
          || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
          return { ok: false as const, error: { code: "traces_not_eligible" as const } };
        }
        const now = options.now().toISOString();
        const snapshot = { schema_version: "submission-trace-close.v1", artifact_ids: approved.map((row) => row.id), artifact_shas: actual };
        const closed = await tx.query<{ submission_id: string }>(
          `INSERT INTO submission_trace_closures (submission_id, owner_entrant_id, snapshot, closed_at)
           VALUES ($1,$2,$3::jsonb,$4::timestamptz)
           ON CONFLICT (submission_id) DO NOTHING RETURNING submission_id`,
          [submission_id, binding.rows[0].entrant_id, JSON.stringify(snapshot), now],
        );
        if (!closed.rows[0]) return { ok: true as const, already_closed: true };
        await tx.query(
          `INSERT INTO domain_audit_events (id,actor_id,action,entity_type,entity_id,correlation_id,safe_metadata,occurred_at)
           VALUES ($1,NULL,'entrant.trace.submission_closed','submission',$2,$3,$4::jsonb,$5)`,
          [deterministicUuid(`entrant.trace.submission_closed\u0000${submission_id}`), submission_id, `trace-close:${submission_id}`, JSON.stringify(snapshot), now],
        );
        return { ok: true as const };
      });
    },
  };
}
