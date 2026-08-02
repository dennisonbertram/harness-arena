import { createHash } from "node:crypto";

type Sql = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };
type Db = Sql & { transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> };
type Actor = { id: string; github_id: number; github_login: string };
type Artifact = { submission_id: string; kind: string; schema_version: string; mime_type: string; compression: string; compressed_bytes: number; uncompressed_bytes: number; sha256: string; consent: string };
type Failure = { ok: false; error: { code: "unauthenticated" | "not_found" | "conflict" | "invalid_state" } };
const fail = (code: Failure["error"]["code"]): Failure => ({ ok: false, error: { code } });
const canonical = (value: any): string => value && typeof value === "object" && !Array.isArray(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

export function createPostgresEntrantTraces(db: Db, options: { ids: { next(): string }; now(): Date }) {
  const tails = new Map<string, Promise<void>>();
  const safeArtifact = (artifact: any) => {
    const { object_key, owner_entrant_id, ...safe } = artifact;
    return safe;
  };
  async function read(id: string, sql: Sql = db) {
    const result = await sql.query<any>(`SELECT id, submission_id, owner_entrant_id, kind, schema_version, object_key, sha256, compression, compressed_bytes, uncompressed_bytes, mime_type, consent, state, reconcile_after FROM submission_artifacts WHERE id = $1`, [id]);
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
      const owner = await db.query<{ entrant_id: string }>("SELECT entrant_id FROM submission_bindings WHERE submission_id=$1 AND entrant_id=$2", [artifact.submission_id, actor.id]);
      if (!owner.rows[0]) return fail("not_found");
      try {
        return await db.transaction(async (tx) => {
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
      await db.query("UPDATE submission_artifacts SET state='uploaded', reconcile_after=$3, updated_at=$3 WHERE id=$1 AND owner_entrant_id=$2 AND state='pending_upload'", [artifact_id, actor.id, now]); return { ok: true as const, artifact: await read(artifact_id) };
    },
    async finalize({ actor, artifact_id, sha256 }: { actor: Actor | null; artifact_id: string; sha256: string }) {
      if (!actor) return fail("unauthenticated"); const a = await read(artifact_id); if (!a || a.owner_entrant_id !== actor.id) return fail("not_found");
      if (a.sha256 !== sha256) {
        if (a.state === "verified") return fail("conflict");
        await db.query("UPDATE submission_artifacts SET state='rejected', rejected_at=$2, updated_at=$2 WHERE id=$1", [artifact_id, options.now().toISOString()]);
        return fail("conflict");
      }
      if (a.state !== "uploaded") return fail("invalid_state");
      await db.query("UPDATE submission_artifacts SET state='verified', verified_at=$3, updated_at=$3 WHERE id=$1 AND owner_entrant_id=$2 AND state='uploaded'", [artifact_id, actor.id, options.now().toISOString()]); return { ok: true as const, artifact: await read(artifact_id) };
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
  };
}
