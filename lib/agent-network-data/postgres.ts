import { createHash, randomUUID } from "node:crypto";

type QueryResult<Row> = { rows: Row[] };
type SqlExecutor = { query<Row>(sql: string, params?: unknown[]): Promise<QueryResult<Row>> };
type SqlClient = SqlExecutor & { transaction<Result>(callback: (tx: SqlExecutor) => Promise<Result>): Promise<Result> };
type Json = boolean | null | number | string | Json[] | { [key: string]: Json };

type EntrantRow = { id: string; github_id: string | number; github_login: string; created_at: string | Date; updated_at: string | Date };
type SessionRow = {
  jti: string; entrant_id: string; issuer: string; audience: string; key_id: string; token_version: number;
  scopes: string[]; expires_at: string | Date; revoked_at: string | Date | null; last_used_at: string | Date | null;
  authenticated_at: string | Date; created_at: string | Date;
};
type MembershipRow = { competition_id: string; entrant_id: string; role: string; state: "active" | "left" | "banned"; joined_at: string | Date; left_at: string | Date | null; banned_at: string | Date | null; updated_at: string | Date };
type AuditRow = { id: string; actor_id: string | null; action: string; entity_type: string; entity_id: string; correlation_id: string; safe_metadata: unknown; occurred_at: string | Date };
type OperationRow = { id: string; request_hash: string; entity_id: string | null; response_json: unknown; state: string };
type OutboxRow = { id: string; operation_id: string; state: "pending" | "processing" | "delivered"; attempts: number; claimed_at: string | Date | null; delivered_at: string | Date | null };

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const iso = (value: string | Date) => new Date(value).toISOString();

function canonicalJson(value: Json): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical request JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

function cloneAndFreeze<Value>(value: Value): Value {
  const cloned = structuredClone(value);
  const freeze = (candidate: unknown): unknown => {
    if (candidate !== null && typeof candidate === "object" && !Object.isFrozen(candidate)) {
      for (const child of Object.values(candidate as Record<string, unknown>)) freeze(child);
      Object.freeze(candidate);
    }
    return candidate;
  };
  return freeze(cloned) as Value;
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function entrant(row: EntrantRow) {
  return cloneAndFreeze({ id: row.id, githubId: String(row.github_id), githubLogin: row.github_login, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}

function session(row: SessionRow) {
  return cloneAndFreeze({
    jti: row.jti, entrantId: row.entrant_id, issuer: row.issuer, audience: row.audience, keyId: row.key_id,
    tokenVersion: row.token_version, scopes: [...row.scopes], expiresAt: iso(row.expires_at),
    revokedAt: row.revoked_at === null ? null : iso(row.revoked_at), lastUsedAt: row.last_used_at === null ? null : iso(row.last_used_at),
    authenticatedAt: iso(row.authenticated_at), createdAt: iso(row.created_at),
  });
}

function audit(row: AuditRow) {
  return cloneAndFreeze({ id: row.id, actorId: row.actor_id, action: row.action, entityType: row.entity_type, entityId: row.entity_id, correlationId: row.correlation_id, safeMetadata: jsonValue(row.safe_metadata), occurredAt: iso(row.occurred_at) });
}

function outbox(row: OutboxRow) {
  return cloneAndFreeze({ id: row.id, operationId: row.operation_id, state: row.state, attempts: Number(row.attempts), claimedAt: row.claimed_at === null ? undefined : iso(row.claimed_at), deliveredAt: row.delivered_at === null ? undefined : iso(row.delivered_at) });
}

export class PostgresIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" as const;
  constructor() { super("idempotency key was already used with a different request"); }
}

export function createPostgresAgentNetworkRepositories(db: SqlClient, options: { ids?: () => string; now?: () => Date } = {}) {
  const newId = options.ids ?? randomUUID;
  const currentTime = options.now ?? (() => new Date());
  const inFlight = new Map<string, { requestHash: string; work: Promise<unknown> }>();
  const completed = new Map<string, { requestHash: string; result: { operationId: string; entityId: string; response: unknown; replayed: boolean } }>();
  const transact = async <Result>(callback: (tx: SqlExecutor) => Promise<Result>) => db.transaction(callback);
  const operationScope = ({ actorId, operation, competitionId, idempotencyKey }: { actorId: string; operation: string; competitionId: string; idempotencyKey: string }) => canonicalJson({ actorId, operation, competitionId, idempotencyKey });

  const entrants = {
    async upsert({ githubId, githubLogin }: { githubId: string; githubLogin: string }) {
      const result = await db.query<EntrantRow>(
        `INSERT INTO entrants (id, github_id, github_login, created_at, updated_at)
         VALUES ($1, $2::bigint, $3, $4, $4)
         ON CONFLICT (github_id) DO UPDATE SET github_login = EXCLUDED.github_login, updated_at = EXCLUDED.updated_at
         RETURNING id, github_id, github_login, created_at, updated_at`,
        [newId(), githubId, githubLogin, currentTime().toISOString()],
      );
      return entrant(result.rows[0]);
    },
  };

  const sessions = {
    async create(input: { jti: string; entrantId: string; issuer: string; audience: string; keyId: string; tokenVersion: number; scopes: string[]; expiresAt: string }) {
      const result = await db.query<SessionRow>(
        `INSERT INTO agent_sessions (jti, entrant_id, issuer, audience, key_id, token_version, scopes, expires_at, authenticated_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::timestamptz, $9::timestamptz, $9::timestamptz)
         RETURNING jti, entrant_id, issuer, audience, key_id, token_version, scopes, expires_at, revoked_at, last_used_at, authenticated_at, created_at`,
        [input.jti, input.entrantId, input.issuer, input.audience, input.keyId, input.tokenVersion, input.scopes, input.expiresAt, currentTime().toISOString()],
      );
      return session(result.rows[0]);
    },
    async get(jti: string) {
      const result = await db.query<SessionRow>(
        `SELECT jti, entrant_id, issuer, audience, key_id, token_version, scopes, expires_at, revoked_at, last_used_at, authenticated_at, created_at FROM agent_sessions WHERE jti = $1`, [jti],
      );
      return result.rows[0] ? session(result.rows[0]) : undefined;
    },
    async list({ entrantId }: { entrantId: string }) {
      const result = await db.query<SessionRow>(
        `SELECT jti, entrant_id, issuer, audience, key_id, token_version, scopes, expires_at, revoked_at, last_used_at, authenticated_at, created_at FROM agent_sessions WHERE entrant_id = $1 ORDER BY created_at, jti`, [entrantId],
      );
      return result.rows.map(session);
    },
    async touch(jti: string) { await db.query(`UPDATE agent_sessions SET last_used_at = $2::timestamptz WHERE jti = $1`, [jti, currentTime().toISOString()]); },
    async revoke(jti: string) { await db.query(`UPDATE agent_sessions SET revoked_at = $2::timestamptz WHERE jti = $1`, [jti, currentTime().toISOString()]); },
    /**
     * Revocation used by the public session-management surface.  Keeping the
     * entrant predicate in the mutation makes a cross-entrant id
     * indistinguishable from a missing id to callers above this boundary.
     */
    async revokeForEntrant({ jti, entrantId }: { jti: string; entrantId: string }) {
      const result = await db.query<{ jti: string }>(
        `UPDATE agent_sessions
         SET revoked_at = COALESCE(revoked_at, $3::timestamptz)
         WHERE jti = $1 AND entrant_id = $2
         RETURNING jti`,
        [jti, entrantId, currentTime().toISOString()],
      );
      return result.rows.length > 0;
    },
    async isAuthenticated(input: { jti: string; issuer: string; audience: string; keyId: string; tokenVersion?: number; now?: Date }) {
      const result = await db.query<{ authenticated: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM agent_sessions
         WHERE jti = $1 AND issuer = $2 AND audience = $3 AND key_id = $4
           AND ($5::integer IS NULL OR token_version = $5) AND revoked_at IS NULL AND expires_at > $6::timestamptz) AS authenticated`,
        [input.jti, input.issuer, input.audience, input.keyId, input.tokenVersion ?? null, (input.now ?? currentTime()).toISOString()],
      );
      return result.rows[0]?.authenticated === true;
    },
  };

  const memberships = {
    async set({ competitionId, entrantId, state }: { competitionId: string; entrantId: string; state: "active" | "left" | "banned" }) {
      const at = currentTime().toISOString();
      const result = await db.query<MembershipRow>(
        `INSERT INTO competition_memberships (competition_id, entrant_id, role, state, joined_at, left_at, banned_at, updated_at)
         VALUES ($1, $2, 'entrant', $3, $4::timestamptz, CASE WHEN $3 = 'left' THEN $4::timestamptz END, CASE WHEN $3 = 'banned' THEN $4::timestamptz END, $4::timestamptz)
         ON CONFLICT (competition_id, entrant_id) DO UPDATE SET role = 'entrant', state = EXCLUDED.state, joined_at = CASE WHEN EXCLUDED.state = 'active' THEN EXCLUDED.updated_at ELSE competition_memberships.joined_at END, left_at = CASE WHEN EXCLUDED.state = 'left' THEN EXCLUDED.updated_at ELSE NULL END, banned_at = CASE WHEN EXCLUDED.state = 'banned' THEN EXCLUDED.updated_at ELSE NULL END, updated_at = EXCLUDED.updated_at
         RETURNING competition_id, entrant_id, role, state, joined_at, left_at, banned_at, updated_at`, [competitionId, entrantId, state, at],
      );
      const row = result.rows[0];
      return cloneAndFreeze({ competitionId: row.competition_id, entrantId: row.entrant_id, role: row.role, state: row.state, joinedAt: iso(row.joined_at), leftAt: row.left_at === null ? null : iso(row.left_at), bannedAt: row.banned_at === null ? null : iso(row.banned_at), updatedAt: iso(row.updated_at) });
    },
    async isActive({ competitionId, entrantId }: { competitionId: string; entrantId: string }) {
      const result = await db.query<{ active: boolean }>(`SELECT EXISTS(SELECT 1 FROM competition_memberships WHERE competition_id = $1 AND entrant_id = $2 AND state = 'active') AS active`, [competitionId, entrantId]);
      return result.rows[0]?.active === true;
    },
  };

  const auditRepo = {
    async append(input: { actorId: string | null; action: string; entityType: string; entityId: string; correlationId: string; safeMetadata: Record<string, Json> }) {
      const result = await db.query<AuditRow>(
        `INSERT INTO domain_audit_events (id, actor_id, action, entity_type, entity_id, correlation_id, safe_metadata, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
         RETURNING id, actor_id, action, entity_type, entity_id, correlation_id, safe_metadata, occurred_at`,
        [newId(), input.actorId, input.action, input.entityType, input.entityId, input.correlationId, JSON.stringify(input.safeMetadata), currentTime().toISOString()],
      );
      return audit(result.rows[0]);
    },
    async list({ entityId }: { entityId: string }) {
      const result = await db.query<AuditRow>(
        `SELECT id, actor_id, action, entity_type, entity_id, correlation_id, safe_metadata, occurred_at FROM domain_audit_events WHERE entity_id = $1 ORDER BY occurred_at, id`, [entityId],
      );
      return result.rows.map(audit);
    },
  };

  const outboxRepo = {
    async list({ operationId }: { operationId: string }) {
      const result = await db.query<OutboxRow>(`SELECT id, operation_id, state, attempts, claimed_at, delivered_at FROM domain_outbox WHERE operation_id = $1 ORDER BY id`, [operationId]);
      return result.rows.map(outbox);
    },
    async claimNext({ now }: { now: Date }) {
      return transact(async (tx) => {
        const result = await tx.query<OutboxRow>(
          `WITH candidate AS (SELECT id FROM domain_outbox WHERE state = 'pending' AND available_at <= $1::timestamptz ORDER BY available_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
           UPDATE domain_outbox AS o SET state = 'processing', attempts = o.attempts + 1, claimed_at = $1::timestamptz FROM candidate WHERE o.id = candidate.id
           RETURNING o.id, o.operation_id, o.state, o.attempts, o.claimed_at, o.delivered_at`, [now.toISOString()],
        );
        return result.rows[0] ? outbox(result.rows[0]) : undefined;
      });
    },
    async recoverStale({ now, olderThanMs }: { now: Date; olderThanMs: number }) {
      await db.query(`UPDATE domain_outbox SET state = 'pending', claimed_at = NULL WHERE state = 'processing' AND claimed_at <= $1::timestamptz`, [new Date(now.getTime() - olderThanMs).toISOString()]);
    },
    async markDelivered(id: string, { now }: { now: Date }) {
      const result = await db.query<OutboxRow>(
        `UPDATE domain_outbox SET state = 'delivered', delivered_at = $2::timestamptz WHERE id = $1 AND state = 'processing' RETURNING id, operation_id, state, attempts, claimed_at, delivered_at`, [id, now.toISOString()],
      );
      if (!result.rows[0]) throw new Error(`outbox record is not processing: ${id}`);
    },
  };

  async function execute<Response>(input: { actorId: string; operation: string; competitionId: string; idempotencyKey: string; request: Json; outbox: { topic: string; payloadVersion: number; safePayload: Record<string, Json> } }, mutate: () => Promise<Response>) {
    const scope = operationScope(input);
    const requestHash = digest(canonicalJson(input.request));
    const cached = completed.get(scope);
    if (cached) {
      if (cached.requestHash !== requestHash) throw new PostgresIdempotencyConflictError();
      return { ...cached.result, response: cloneAndFreeze(cached.result.response as Response), replayed: true };
    }
    const inProgress = inFlight.get(scope) as { requestHash: string; work: Promise<{ operationId: string; entityId: string; response: Response; replayed: boolean }> } | undefined;
    if (inProgress) {
      if (inProgress.requestHash !== requestHash) throw new PostgresIdempotencyConflictError();
      const result = await inProgress.work;
      return { ...result, response: cloneAndFreeze(result.response), replayed: true };
    }
    let resolve!: (value: { operationId: string; entityId: string; response: Response; replayed: boolean }) => void;
    let reject!: (reason?: unknown) => void;
    const work = new Promise<{ operationId: string; entityId: string; response: Response; replayed: boolean }>((accept, fail) => { resolve = accept; reject = fail; });
    inFlight.set(scope, { requestHash, work });
    void (async () => {
      try {
        const result = await transact(async (tx) => {
          const existing = await tx.query<OperationRow>(
            `SELECT id, request_hash, entity_id, response_json, state FROM idempotency_operations WHERE actor_id = $1 AND competition_id IS NOT DISTINCT FROM $2 AND operation = $3 AND idempotency_key = $4 FOR UPDATE`,
            [input.actorId, input.competitionId, input.operation, input.idempotencyKey],
          );
          if (existing.rows[0]) {
            const row = existing.rows[0];
            if (row.request_hash !== requestHash) throw new PostgresIdempotencyConflictError();
            if (row.state === "completed") return { operationId: row.id, entityId: row.entity_id!, response: cloneAndFreeze(jsonValue(row.response_json) as Response), replayed: true };
            throw new Error("idempotency operation is pending recovery");
          }
          const operationId = newId();
          const entityId = `entity_${digest(scope)}`;
          const at = currentTime().toISOString();
          await tx.query(
            `INSERT INTO idempotency_operations (id, actor_id, competition_id, operation, idempotency_key, request_hash, entity_id, state, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8::timestamptz, $8::timestamptz)`,
            [operationId, input.actorId, input.competitionId, input.operation, input.idempotencyKey, requestHash, entityId, at],
          );
          await tx.query(
            `INSERT INTO domain_outbox (id, operation_id, topic, payload_version, safe_payload, state, available_at, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6::timestamptz, $6::timestamptz)`,
            [newId(), operationId, input.outbox.topic, input.outbox.payloadVersion, JSON.stringify(input.outbox.safePayload), at],
          );
          // Only the transaction that installed this reservation may invoke
          // the callback. An already-completed durable operation replays
          // above without risking a second external effect.
          const response = cloneAndFreeze(await mutate());
          await tx.query(`UPDATE idempotency_operations SET response_json = $2::jsonb, state = 'completed', completed_at = $3::timestamptz, updated_at = $3::timestamptz WHERE id = $1`, [operationId, JSON.stringify(response), at]);
          return { operationId, entityId, response: cloneAndFreeze(response), replayed: false };
        });
        completed.set(scope, { requestHash, result });
        resolve(result);
      } catch (error) { reject(error); } finally { inFlight.delete(scope); }
    })();
    return work;
  }

  return { entrants, sessions, memberships, audit: auditRepo, outbox: outboxRepo, execute };
}
