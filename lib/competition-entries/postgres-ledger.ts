import { createHash, randomUUID } from "node:crypto";

type QueryResult<Row> = { rows: Row[] };
type Sql = { query<Row>(sql: string, params?: unknown[]): Promise<QueryResult<Row>> };
type Database = Sql & { transaction<Result>(work: (tx: Sql) => Promise<Result>): Promise<Result> };

type Actor = { entrant_id: string; github_id: number; github_login: string };
type Phase = "reserved" | "judge_started" | "verdict_persisted" | "submission_written" | "run_written" | "run_created_appended" | "committed";
type Response = { submission_id: string; run_id?: string; status: "queued" | "rejected" };
type SagaRow = {
  operation_id: string; entrant_id: string; competition_id: string; idempotency_key: string;
  request_hash: string; request_json: unknown; submission_id: string; run_id: string;
  phase: Phase; verdict_json: unknown; response_json: unknown; state: "pending" | "completed";
  lease_token: string | null; lease_expires_at: string | Date | null;
};
type LifecycleGateRow = {
  competition_id: string;
  state: "live" | "closed";
  close_generation: string | null;
  closed_at: string | Date | null;
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical request JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("canonical request JSON must be JSON");
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
};

const requestHash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const json = <Value>(value: unknown): Value => typeof value === "string" ? JSON.parse(value) as Value : value as Value;
const isPhase = (value: string): value is Phase => ["reserved", "judge_started", "verdict_persisted", "submission_written", "run_written", "run_created_appended", "committed"].includes(value);

export class CompetitionEntryLedgerError extends Error {
  constructor(readonly code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" | "ENTRY_SAGA_PHASE_CONFLICT" | "ENTRY_SAGA_NOT_FOUND" | "ENTRY_AUTHORIZATION_REVOKED" | "COMPETITION_CLOSED") {
    super(code);
  }
}

/**
 * The private persistence seam for the versioned entry protocol. No caller is
 * given a way to load prompt-bearing state except `load`, which is used by the
 * trusted saga/reconciler; `project` is deliberately allowlisted.
 */
export function createPostgresCompetitionEntryLedger(
  db: Database,
  options: { ids?: () => string; now?: () => Date } = {},
) {
  const id = options.ids ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const reservations = new Map<string, Promise<Reservation>>();

  type Reservation = { operation_id: string; submission_id: string; run_id: string; phase: Phase; replay: Response | undefined };
  const scope = (actor: Actor, request: { competition_id: string; idempotency_key: string }) => `${actor.entrant_id}\u0000${request.competition_id}\u0000${request.idempotency_key}`;
  const reservation = (row: Pick<SagaRow, "operation_id" | "submission_id" | "run_id" | "phase" | "state" | "response_json">): Reservation => ({
    operation_id: row.operation_id,
    submission_id: row.submission_id,
    run_id: row.run_id,
    phase: row.phase,
    replay: row.state === "completed" && row.response_json !== null ? json<Response>(row.response_json) : undefined,
  });

  async function lockLifecycleGate(sql: Sql, competitionId: string, at: string): Promise<LifecycleGateRow> {
    await sql.query(
      `INSERT INTO competition_lifecycle_gates (competition_id, state, created_at, updated_at)
       VALUES ($1, 'live', $2::timestamptz, $2::timestamptz)
       ON CONFLICT (competition_id) DO NOTHING`,
      [competitionId, at],
    );
    const result = await sql.query<LifecycleGateRow>(
      `SELECT competition_id, state, close_generation, closed_at
       FROM competition_lifecycle_gates WHERE competition_id=$1 FOR UPDATE`,
      [competitionId],
    );
    if (!result.rows[0]) throw new CompetitionEntryLedgerError("ENTRY_SAGA_PHASE_CONFLICT");
    return result.rows[0];
  }

  async function requireLiveLifecycleGate(sql: Sql, competitionId: string, at: string): Promise<void> {
    if ((await lockLifecycleGate(sql, competitionId, at)).state !== "live") {
      throw new CompetitionEntryLedgerError("COMPETITION_CLOSED");
    }
  }

  async function reserveOne(input: { actor: Actor; request: { competition_id: string; idempotency_key: string } & Record<string, unknown> }): Promise<Reservation> {
    const hash = requestHash(input.request);
    return db.transaction(async (tx) => {
      const prior = await tx.query<SagaRow>(
        `SELECT operation_id, entrant_id, competition_id, idempotency_key, request_hash, request_json, submission_id, run_id, phase, verdict_json, response_json, state
         FROM competition_entry_sagas WHERE entrant_id = $1 AND competition_id = $2 AND idempotency_key = $3 FOR UPDATE`,
        [input.actor.entrant_id, input.request.competition_id, input.request.idempotency_key],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== hash) throw new CompetitionEntryLedgerError("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST");
        return reservation(prior.rows[0]);
      }

      const operationId = id();
      const submissionId = id();
      const runId = id();
      const at = now().toISOString();
      await requireLiveLifecycleGate(tx, input.request.competition_id, at);
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO idempotency_operations (id, actor_id, competition_id, operation, idempotency_key, request_hash, entity_id, state, created_at, updated_at)
         VALUES ($1, $2, $3, 'competition.entry.submit.v1', $4, $5, $6, 'pending', $7::timestamptz, $7::timestamptz)
         ON CONFLICT (actor_id, competition_id, operation, idempotency_key) DO NOTHING
         RETURNING id`,
        [operationId, input.actor.entrant_id, input.request.competition_id, input.request.idempotency_key, hash, submissionId, at],
      );
      if (!inserted.rows[0]) {
        const winner = await tx.query<SagaRow>(
          `SELECT s.operation_id, s.entrant_id, s.competition_id, s.idempotency_key, s.request_hash,
                  s.request_json, s.submission_id, s.run_id, s.phase, s.verdict_json, s.response_json,
                  s.state, s.lease_token, s.lease_expires_at
           FROM competition_entry_sagas s
           JOIN idempotency_operations i ON i.id = s.operation_id
           WHERE i.actor_id=$1 AND i.competition_id=$2
             AND i.operation='competition.entry.submit.v1' AND i.idempotency_key=$3
           FOR UPDATE OF s`,
          [input.actor.entrant_id, input.request.competition_id, input.request.idempotency_key],
        );
        if (!winner.rows[0]) throw new CompetitionEntryLedgerError("ENTRY_SAGA_PHASE_CONFLICT");
        if (winner.rows[0].request_hash !== hash) throw new CompetitionEntryLedgerError("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST");
        return reservation(winner.rows[0]);
      }
      await tx.query(
        `INSERT INTO competition_entry_sagas (operation_id, entrant_id, competition_id, idempotency_key, request_hash, request_json, submission_id, run_id, phase, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'reserved', 'pending', $9::timestamptz, $9::timestamptz)`,
        [operationId, input.actor.entrant_id, input.request.competition_id, input.request.idempotency_key, hash, JSON.stringify(input.request), submissionId, runId, at],
      );
      return { operation_id: operationId, submission_id: submissionId, run_id: runId, phase: "reserved", replay: undefined };
    });
  }

  async function saga(operationId: string, sql: Sql = db, lock = false): Promise<SagaRow> {
    const result = await sql.query<SagaRow>(
      `SELECT operation_id, entrant_id, competition_id, idempotency_key, request_hash, request_json, submission_id, run_id, phase, verdict_json, response_json, state, lease_token, lease_expires_at
       FROM competition_entry_sagas WHERE operation_id = $1${lock ? " FOR UPDATE" : ""}`, [operationId],
    );
    if (!result.rows[0]) throw new CompetitionEntryLedgerError("ENTRY_SAGA_NOT_FOUND");
    return result.rows[0];
  }

  return {
    async markCompetitionClosed({ competition_id, closed_at }: { competition_id: string; closed_at: string }) {
      const parsedClosedAt = new Date(closed_at);
      if (!competition_id || !Number.isFinite(parsedClosedAt.getTime()) || parsedClosedAt.toISOString() !== closed_at) {
        throw new CompetitionEntryLedgerError("ENTRY_SAGA_PHASE_CONFLICT");
      }
      return db.transaction(async (tx) => {
        const gate = await lockLifecycleGate(tx, competition_id, closed_at);
        if (gate.state === "closed") {
          if (!gate.close_generation || !gate.closed_at) throw new CompetitionEntryLedgerError("ENTRY_SAGA_PHASE_CONFLICT");
          return {
            competition_id: gate.competition_id,
            close_generation: gate.close_generation,
            closed_at: new Date(gate.closed_at).toISOString(),
          };
        }
        const closeGeneration = id();
        const updated = await tx.query<LifecycleGateRow>(
          `UPDATE competition_lifecycle_gates
           SET state='closed', close_generation=$2, closed_at=$3::timestamptz, updated_at=$3::timestamptz
           WHERE competition_id=$1 AND state='live'
           RETURNING competition_id, state, close_generation, closed_at`,
          [competition_id, closeGeneration, closed_at],
        );
        const row = updated.rows[0];
        if (!row?.close_generation || !row.closed_at) throw new CompetitionEntryLedgerError("ENTRY_SAGA_PHASE_CONFLICT");
        return {
          competition_id: row.competition_id,
          close_generation: row.close_generation,
          closed_at: new Date(row.closed_at).toISOString(),
        };
      });
    },

    async reserve(input: { actor: Actor; request: { competition_id: string; idempotency_key: string } & Record<string, unknown> }) {
      const key = scope(input.actor, input.request);
      const inFlight = reservations.get(key);
      if (inFlight) return inFlight;
      const work = reserveOne(input);
      reservations.set(key, work);
      try { return await work; } finally { if (reservations.get(key) === work) reservations.delete(key); }
    },

    async load({ operation_id }: { operation_id: string }) {
      const row = await saga(operation_id);
      const actor = await db.query<{ github_id: string | number; github_login: string }>(
        "SELECT github_id, github_login FROM entrants WHERE id = $1", [row.entrant_id],
      );
      if (!actor.rows[0]) throw new CompetitionEntryLedgerError("ENTRY_SAGA_NOT_FOUND");
      return {
        operation_id: row.operation_id,
        submission_id: row.submission_id,
        run_id: row.run_id,
        actor: { entrantId: row.entrant_id, githubId: Number(actor.rows[0].github_id), githubLogin: actor.rows[0].github_login },
        request: json<unknown>(row.request_json),
        phase: row.phase,
        ...(row.verdict_json === null ? {} : { verdict: json<unknown>(row.verdict_json) }),
        ...(row.phase === "verdict_persisted" && row.verdict_json !== null ? { checkpoint_value: json<unknown>(row.verdict_json) } : {}),
        reconciliation_required: row.phase === "judge_started",
      };
    },

    async claim({ operation_id, lease_ms }: { operation_id: string; lease_ms: number }) {
      if (!Number.isSafeInteger(lease_ms) || lease_ms < 1_000 || lease_ms > 300_000) {
        throw new CompetitionEntryLedgerError("ENTRY_SAGA_PHASE_CONFLICT");
      }
      const leaseToken = id();
      const at = now();
      const expiresAt = new Date(at.getTime() + lease_ms);
      const result = await db.query<{ lease_token: string }>(
        `UPDATE competition_entry_sagas
         SET lease_token=$2, lease_expires_at=$3::timestamptz, updated_at=$4::timestamptz
         WHERE operation_id=$1 AND state='pending'
           AND (lease_token IS NULL OR lease_expires_at <= $4::timestamptz)
         RETURNING lease_token`,
        [operation_id, leaseToken, expiresAt.toISOString(), at.toISOString()],
      );
      return result.rows[0] ? { lease_token: result.rows[0].lease_token } : null;
    },

    async renew({ operation_id, lease_token, lease_ms }: { operation_id: string; lease_token: string; lease_ms: number }) {
      if (!Number.isSafeInteger(lease_ms) || lease_ms < 1_000 || lease_ms > 300_000) {
        throw new CompetitionEntryLedgerError("ENTRY_SAGA_PHASE_CONFLICT");
      }
      const at = now();
      const expiresAt = new Date(at.getTime() + lease_ms);
      const result = await db.query<{ operation_id: string }>(
        `UPDATE competition_entry_sagas
         SET lease_expires_at=$3::timestamptz, updated_at=$4::timestamptz
         WHERE operation_id=$1 AND state='pending' AND lease_token=$2
           AND lease_expires_at > $4::timestamptz
         RETURNING operation_id`,
        [operation_id, lease_token, expiresAt.toISOString(), at.toISOString()],
      );
      return Boolean(result.rows[0]);
    },

    async release({ operation_id, lease_token }: { operation_id: string; lease_token: string }) {
      await db.query(
        `UPDATE competition_entry_sagas
         SET lease_token=NULL, lease_expires_at=NULL, updated_at=$3::timestamptz
         WHERE operation_id=$1 AND state='pending' AND lease_token=$2`,
        [operation_id, lease_token, now().toISOString()],
      );
    },

    async checkpoint(input: { operation_id: string; lease_token: string; expected_phase: Phase; phase: Phase; value?: unknown }) {
      if (!isPhase(input.phase) || !isPhase(input.expected_phase)) throw new CompetitionEntryLedgerError("ENTRY_SAGA_PHASE_CONFLICT");
      const at = now().toISOString();
      const result = await db.query<{ operation_id: string }>(
        `UPDATE competition_entry_sagas
         SET phase = $3, verdict_json = CASE WHEN $3 = 'verdict_persisted' THEN $4::jsonb ELSE verdict_json END, updated_at = $5::timestamptz
         WHERE operation_id = $1 AND state = 'pending' AND phase = $2
           AND lease_token = $6 AND lease_expires_at > $5::timestamptz
         RETURNING operation_id`,
        [input.operation_id, input.expected_phase, input.phase, input.value === undefined ? null : JSON.stringify(input.value), at, input.lease_token],
      );
      if (!result.rows[0]) throw new CompetitionEntryLedgerError("ENTRY_SAGA_PHASE_CONFLICT");
    },

    async complete({ operation_id, lease_token, response }: { operation_id: string; lease_token: string; response: Response }) {
      await db.transaction(async (tx) => {
        const row = await saga(operation_id, tx, true);
        if (row.state === "completed") {
          if (canonicalJson(json<unknown>(row.response_json)) !== canonicalJson(response)) throw new CompetitionEntryLedgerError("ENTRY_SAGA_PHASE_CONFLICT");
          return;
        }
        const at = now().toISOString();
        if (row.lease_token !== lease_token || row.lease_expires_at === null || new Date(row.lease_expires_at).getTime() <= new Date(at).getTime()) {
          throw new CompetitionEntryLedgerError("ENTRY_SAGA_PHASE_CONFLICT");
        }
        const verdict = row.verdict_json === null ? null : json<{ verdict?: unknown }>(row.verdict_json);
        const validQueued = response.status === "queued"
          && response.submission_id === row.submission_id
          && response.run_id === row.run_id
          && row.phase === "run_created_appended"
          && verdict?.verdict === "approved";
        const validRejected = response.status === "rejected"
          && response.submission_id === row.submission_id
          && response.run_id === undefined
          && row.phase === "submission_written"
          && verdict?.verdict === "rejected";
        if (!validQueued && !validRejected) throw new CompetitionEntryLedgerError("ENTRY_SAGA_PHASE_CONFLICT");
        await requireLiveLifecycleGate(tx, row.competition_id, at);
        const membership = await tx.query<{ state: "active" | "left" | "banned" }>(
          `SELECT state FROM competition_memberships
           WHERE competition_id=$1 AND entrant_id=$2 FOR UPDATE`,
          [row.competition_id, row.entrant_id],
        );
        if (membership.rows[0] && membership.rows[0].state !== "active") {
          throw new CompetitionEntryLedgerError("ENTRY_AUTHORIZATION_REVOKED");
        }
        await tx.query(
          `INSERT INTO submission_bindings (submission_id, competition_id, entrant_id, entry_kind, entry_schema_version, created_at)
           VALUES ($1, $2, $3, 'prompt', 'submit_entry.v1', $4::timestamptz)
           ON CONFLICT (submission_id) DO NOTHING`, [row.submission_id, row.competition_id, row.entrant_id, at],
        );
        const binding = await tx.query<{ competition_id: string; entrant_id: string; entry_kind: string; entry_schema_version: string }>(
          "SELECT competition_id, entrant_id, entry_kind, entry_schema_version FROM submission_bindings WHERE submission_id=$1",
          [row.submission_id],
        );
        if (binding.rows[0]?.competition_id !== row.competition_id
          || binding.rows[0]?.entrant_id !== row.entrant_id
          || binding.rows[0]?.entry_kind !== "prompt"
          || binding.rows[0]?.entry_schema_version !== "submit_entry.v1") {
          throw new CompetitionEntryLedgerError("ENTRY_SAGA_PHASE_CONFLICT");
        }
        await tx.query(
          `INSERT INTO competition_memberships (competition_id, entrant_id, role, state, joined_at, left_at, banned_at, updated_at)
           VALUES ($1, $2, 'entrant', 'active', $3::timestamptz, NULL, NULL, $3::timestamptz)
           ON CONFLICT (competition_id, entrant_id) DO UPDATE
             SET state = CASE WHEN competition_memberships.state = 'banned' THEN 'banned' ELSE 'active' END,
                 updated_at = EXCLUDED.updated_at`, [row.competition_id, row.entrant_id, at],
        );
        await tx.query(
          `INSERT INTO domain_audit_events (id, actor_id, action, entity_type, entity_id, correlation_id, safe_metadata, occurred_at)
           VALUES ($1, $2, 'competition.entry.completed', 'competition_entry', $3, $4, $5::jsonb, $6::timestamptz)`,
          [randomUUID(), row.entrant_id, row.submission_id, row.operation_id, JSON.stringify({ competition_id: row.competition_id, status: response.status }), at],
        );
        await tx.query(
          `INSERT INTO domain_outbox (id, operation_id, topic, payload_version, safe_payload, state, available_at, created_at)
           VALUES ($1, $2, 'competition.entry.completed', 1, $3::jsonb, 'pending', $4::timestamptz, $4::timestamptz)`,
          [randomUUID(), row.operation_id, JSON.stringify({ submission_id: row.submission_id, run_id: row.run_id, status: response.status }), at],
        );
        await tx.query(
          `UPDATE competition_entry_sagas
           SET phase = 'committed', response_json = $2::jsonb, state = 'completed',
               lease_token=NULL, lease_expires_at=NULL,
               completed_at = $3::timestamptz, updated_at = $3::timestamptz
           WHERE operation_id = $1`,
          [row.operation_id, JSON.stringify(response), at],
        );
        await tx.query(
          `UPDATE idempotency_operations SET response_json = $2::jsonb, state = 'completed', completed_at = $3::timestamptz, updated_at = $3::timestamptz WHERE id = $1`,
          [row.operation_id, JSON.stringify(response), at],
        );
      });
    },

    async project({ operation_id }: { operation_id: string }) {
      const row = await saga(operation_id);
      return {
        operation_id: row.operation_id,
        submission_id: row.submission_id,
        run_id: row.run_id,
        phase: row.phase,
        state: row.state,
        ...(row.response_json === null ? {} : { response: json<Response>(row.response_json) }),
      };
    },
  };
}
