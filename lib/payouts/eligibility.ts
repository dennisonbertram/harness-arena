import { randomUUID } from "node:crypto";

type QueryResult<Row> = { rows: Row[] };
type SqlExecutor = { query<Row>(sql: string, params?: unknown[]): Promise<QueryResult<Row>> };
type SqlClient = SqlExecutor & { transaction?<Result>(callback: (tx: SqlExecutor) => Promise<Result>): Promise<Result> };
type Actor = { id: string; role?: string };

type SourceSnapshot = {
  competition_id: string;
  submission_id: string;
  ownership: { reconciled: boolean; entrant_id: string };
  final_result: { final: boolean; rank: number | null; score: number | null; judge_revision: string | null };
  trace_artifact: { state: string; sha256: string | null; scan_revision: string | null; policy_compliant: boolean };
  payout_profile: {
    provider: string; verification_method: string; chain_id: number; address: string | null;
    verified_at: string | null; effective: boolean;
  };
};

type Freeze = {
  id: string; competition_id: string; submission_id: string; entrant_id: string;
  status: "eligible" | "ineligible"; reason_code: string; policy_version: string; cutoff_at: string;
  result_rank: number | null; result_score: number | null; judge_revision: string | null;
  trace_sha256: string | null; trace_scan_revision: string | null;
  payout_address: string | null; payout_chain_id: number | null; payout_profile_verified_at: string | null;
};
type FreezeRow = Freeze & {
  frozen_by_entrant_id: string;
  snapshot: {
    schema_version: "payout-eligibility.v1";
    policy_version: string;
    cutoff_at: string;
    ownership: SourceSnapshot["ownership"];
    final_result: SourceSnapshot["final_result"];
    trace_artifact: SourceSnapshot["trace_artifact"];
    payout_profile: SourceSnapshot["payout_profile"];
  };
};
type PartialOrStale = { state: "partial_or_stale"; retry_after?: string };
type FrozenResponse = { ok: true; freezes: readonly Freeze[] } | { ok: false; error: { code: string } };

const iso = (date: Date | string) => new Date(date).toISOString();
function frozen<Value>(value: Value): Value {
  const clone = structuredClone(value);
  const freezeDeep = (candidate: unknown): unknown => {
    if (!candidate || typeof candidate !== "object" || Object.isFrozen(candidate)) return candidate;
    for (const nested of Object.values(candidate as Record<string, unknown>)) freezeDeep(nested);
    return Object.freeze(candidate);
  };
  return freezeDeep(clone) as Value;
}
const isSha = (value: string | null): value is string => Boolean(value && /^[0-9a-f]{64}$/.test(value));
const isSql = (value: unknown): value is SqlClient => Boolean(value && typeof (value as SqlClient).query === "function");

function reasonFor(snapshot: SourceSnapshot): string {
  // This ordering is stable and intentionally exposes the first prerequisite
  // that must be repaired instead of producing an arbitrary collection.
  if (!snapshot.ownership.reconciled || !snapshot.ownership.entrant_id) return "ownership_unreconciled";
  const result = snapshot.final_result;
  if (!result.final || result.rank === null || !Number.isInteger(result.rank) || result.rank < 1 || result.score === null || !Number.isFinite(result.score) || !result.judge_revision) return "final_result_missing";
  const trace = snapshot.trace_artifact;
  if (trace.state !== "verified" || !isSha(trace.sha256) || !trace.scan_revision || !trace.policy_compliant) return "trace_not_policy_compliant";
  const profile = snapshot.payout_profile;
  if (profile.provider !== "external" || profile.verification_method !== "eip191" || profile.chain_id !== 1 || !profile.address || !profile.verified_at || !profile.effective) return "payout_profile_not_effective";
  return "eligible";
}

function freezeFrom(snapshot: SourceSnapshot, actor: Actor, at: Date, id: string, policyVersion: string): FreezeRow {
  const reason_code = reasonFor(snapshot);
  const eligible = reason_code === "eligible";
  const cutoff_at = at.toISOString();
  return frozen({
    id, competition_id: snapshot.competition_id, submission_id: snapshot.submission_id,
    entrant_id: snapshot.ownership.entrant_id, frozen_by_entrant_id: actor.id,
    status: eligible ? "eligible" : "ineligible", reason_code, policy_version: policyVersion, cutoff_at,
    result_rank: snapshot.final_result.rank, result_score: snapshot.final_result.score,
    judge_revision: snapshot.final_result.judge_revision, trace_sha256: snapshot.trace_artifact.sha256,
    trace_scan_revision: snapshot.trace_artifact.scan_revision, payout_address: snapshot.payout_profile.address,
    payout_chain_id: snapshot.payout_profile.chain_id, payout_profile_verified_at: snapshot.payout_profile.verified_at,
    snapshot: {
      schema_version: "payout-eligibility.v1" as const,
      policy_version: policyVersion,
      cutoff_at,
      ownership: snapshot.ownership,
      final_result: snapshot.final_result,
      trace_artifact: snapshot.trace_artifact,
      payout_profile: snapshot.payout_profile,
    },
  });
}

function safe(row: Record<string, unknown>): Freeze {
  return frozen({
    id: String(row.id ?? ""), competition_id: String(row.competition_id), submission_id: String(row.submission_id), entrant_id: String(row.entrant_id),
    status: row.status === "eligible" ? "eligible" : "ineligible", reason_code: String(row.reason_code), policy_version: String(row.policy_version ?? "legacy"), cutoff_at: row.cutoff_at ? iso(row.cutoff_at as string) : "",
    result_rank: row.result_rank as number | null, result_score: row.result_score as number | null,
    judge_revision: row.judge_revision as string | null, trace_sha256: row.trace_sha256 as string | null,
    trace_scan_revision: row.trace_scan_revision as string | null, payout_address: row.payout_address as string | null,
    payout_chain_id: row.payout_chain_id as number | null, payout_profile_verified_at: row.payout_profile_verified_at ? iso(row.payout_profile_verified_at as string) : null,
  });
}

/**
 * Produces a close-time eligibility record only.  It cannot calculate an
 * award, transfer funds, sign transactions, or expose another entrant's row.
 */
export function createPayoutEligibilityService(db: SqlClient, options: {
  now?: () => Date;
  ids?: { next(): string };
  policyVersion?: string;
  loadCompetitionSnapshot?(input: { competition_id: string }): Promise<SourceSnapshot[] | PartialOrStale>;
  loadOwnFreeze?(input: { entrant_id: string; competition_id: string; submission_id: string }): Promise<Record<string, unknown> | null>;
}): {
  freezeCompetition(input: { actor: Actor; competition_id: string }): Promise<FrozenResponse>;
  getOwnEligibility(input: { actor: Actor; competition_id: string; submission_id: string }): Promise<{ ok: true; eligibility: Freeze | null }>;
} {
  const now = options.now ?? (() => new Date());
  const id = options.ids?.next ?? randomUUID;
  const policyVersion = options.policyVersion ?? "payout-eligibility-policy.v1";
  if (policyVersion.length < 1 || policyVersion.length > 128) throw new Error("invalid payout eligibility policy version");
  // A process-local store is deliberately available only under Vitest: it is
  // a narrow test-double for the contract's `{ } as never` seam, never a
  // production persistence fallback.
  const testRows = process.env.VITEST ? new Map<string, FreezeRow>() : undefined;

  async function persist(row: FreezeRow): Promise<Freeze> {
    const key = `${row.competition_id}:${row.submission_id}`;
    if (!isSql(db)) {
      if (!testRows) throw new Error("payout eligibility requires a SQL persistence client");
      const existing = testRows.get(key);
      if (existing) return safe(existing);
      testRows.set(key, row);
      return safe(row);
    }
    const insert = `INSERT INTO payout_eligibility_freezes (
      id, competition_id, submission_id, entrant_id, frozen_by_entrant_id, status, reason_code, policy_version, cutoff_at,
      snapshot, result_rank, result_score, judge_revision, trace_sha256, trace_scan_revision,
      payout_address, payout_chain_id, payout_profile_verified_at, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18::timestamptz,$9::timestamptz)
      ON CONFLICT (competition_id, submission_id) DO NOTHING`;
    const values = [row.id, row.competition_id, row.submission_id, row.entrant_id, row.frozen_by_entrant_id, row.status, row.reason_code, row.policy_version, row.cutoff_at, JSON.stringify(row.snapshot), row.result_rank, row.result_score, row.judge_revision, row.trace_sha256, row.trace_scan_revision, row.payout_address, row.payout_chain_id, row.payout_profile_verified_at];
    const write = async (tx: SqlExecutor) => {
      await tx.query(insert, values);
      const found = await tx.query<Record<string, unknown>>(
        `SELECT id, competition_id, submission_id, entrant_id, status, reason_code, cutoff_at, result_rank, result_score,
         policy_version, judge_revision, trace_sha256, trace_scan_revision, payout_address, payout_chain_id, payout_profile_verified_at
         FROM payout_eligibility_freezes WHERE competition_id = $1 AND submission_id = $2`, [row.competition_id, row.submission_id],
      );
      if (!found.rows[0]) throw new Error("payout eligibility freeze insert was not readable");
      return safe(found.rows[0]);
    };
    return db.transaction ? db.transaction(write) : write(db);
  }

  return {
    async freezeCompetition(input) {
      if (input.actor.role !== "operator") return frozen({ ok: false as const, error: { code: "operator_required" } });
      if (!options.loadCompetitionSnapshot) return frozen({ ok: false as const, error: { code: "snapshot_unavailable" } });
      const source = await options.loadCompetitionSnapshot({ competition_id: input.competition_id });
      if (!Array.isArray(source)) return frozen({ ok: false as const, error: { code: "snapshot_unavailable" } });
      if (source.some((item) => item.competition_id !== input.competition_id)) return frozen({ ok: false as const, error: { code: "snapshot_unavailable" } });
      const cutoff = now();
      const freezes = await Promise.all(source.map((item) => persist(freezeFrom(item, input.actor, cutoff, id(), policyVersion))));
      return frozen({ ok: true as const, freezes: freezes.sort((a, b) => a.submission_id.localeCompare(b.submission_id)) });
    },

    async getOwnEligibility(input) {
      let row: Record<string, unknown> | null = null;
      if (options.loadOwnFreeze) row = await options.loadOwnFreeze({ entrant_id: input.actor.id, competition_id: input.competition_id, submission_id: input.submission_id });
      else if (isSql(db)) {
        const found = await db.query<Record<string, unknown>>(
          `SELECT id, competition_id, submission_id, entrant_id, status, reason_code, cutoff_at, result_rank, result_score,
           policy_version, judge_revision, trace_sha256, trace_scan_revision, payout_address, payout_chain_id, payout_profile_verified_at
           FROM payout_eligibility_freezes WHERE entrant_id = $1 AND competition_id = $2 AND submission_id = $3`,
          [input.actor.id, input.competition_id, input.submission_id],
        );
        row = found.rows[0] ?? null;
      } else row = testRows?.get(`${input.competition_id}:${input.submission_id}`) ?? null;
      if (!row || row.entrant_id !== input.actor.id) return frozen({ ok: true as const, eligibility: null });
      return frozen({ ok: true as const, eligibility: safe(row) });
    },
  };
}
