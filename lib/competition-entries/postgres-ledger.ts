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
  constructor(readonly code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" | "ENTRY_SAGA_PHASE_CONFLICT" | "ENTRY_SAGA_NOT_FOUND") {
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
      await tx.query(
        `INSERT INTO idempotency_operations (id, actor_id, competition_id, operation, idempotency_key, request_hash, entity_id, state, created_at, updated_at)
         VALUES ($1, $2, $3, 'competition.entry.submit.v1', $4, $5, $6, 'pending', $7::timestamptz, $7::timestamptz)`,
        [operationId, input.actor.entrant_id, input.request.competition_id, input.request.idempotency_key, hash, submissionId, at],
      );
      await tx.query(
        `INSERT INTO competition_entry_sagas (operation_id, entrant_id, competition_id, idempotency_key, request_hash, request_json, submission_id, run_id, phase, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'reserved', 'pending', $9::timestamptz, $9::timestamptz)`,
        [operationId, input.actor.entrant_id, input.request.competition_id, input.request.idempotency_key, hash, JSON.stringify(input.request), submissionId, runId, at],
      );
      return { operation_id: operationId, submission_id: submissionId, run_id: runId, phase: "reserved", replay: undefined };
    });
  }

  async function saga(operationId: string, sql: Sql = db): Promise<SagaRow> {
    const result = await sql.query<SagaRow>(
      `SELECT operation_id, entrant_id, competition_id, idempotency_key, request_hash, request_json, submission_id, run_id, phase, verdict_json, response_json, state
       FROM competition_entry_sagas WHERE operation_id = $1`, [operationId],
    );
    if (!result.rows[0]) throw new CompetitionEntryLedgerError("ENTRY_SAGA_NOT_FOUND");
    return result.rows[0];
  }

  return {
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

    async checkpoint(input: { operation_id: string; expected_phase: Phase; phase: Phase; value?: unknown }) {
      if (!isPhase(input.phase) || !isPhase(input.expected_phase)) throw new CompetitionEntryLedgerError("ENTRY_SAGA_PHASE_CONFLICT");
      const at = now().toISOString();
      const result = await db.query<{ operation_id: string }>(
        `UPDATE competition_entry_sagas
         SET phase = $3, verdict_json = CASE WHEN $3 = 'verdict_persisted' THEN $4::jsonb ELSE verdict_json END, updated_at = $5::timestamptz
         WHERE operation_id = $1 AND state = 'pending' AND phase = $2
         RETURNING operation_id`,
        [input.operation_id, input.expected_phase, input.phase, input.value === undefined ? null : JSON.stringify(input.value), at],
      );
      if (!result.rows[0]) throw new CompetitionEntryLedgerError("ENTRY_SAGA_PHASE_CONFLICT");
    },

    async complete({ operation_id, response }: { operation_id: string; response: Response }) {
      await db.transaction(async (tx) => {
        const row = await saga(operation_id, tx);
        if (row.state === "completed") {
          if (canonicalJson(json<unknown>(row.response_json)) !== canonicalJson(response)) throw new CompetitionEntryLedgerError("ENTRY_SAGA_PHASE_CONFLICT");
          return;
        }
        const at = now().toISOString();
        await tx.query(
          `INSERT INTO submission_bindings (submission_id, competition_id, entrant_id, entry_kind, entry_schema_version, created_at)
           VALUES ($1, $2, $3, 'prompt', 'submit_entry.v1', $4::timestamptz)
           ON CONFLICT (submission_id) DO NOTHING`, [row.submission_id, row.competition_id, row.entrant_id, at],
        );
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
          `UPDATE competition_entry_sagas SET phase = 'committed', response_json = $2::jsonb, state = 'completed', completed_at = $3::timestamptz, updated_at = $3::timestamptz WHERE operation_id = $1`,
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
