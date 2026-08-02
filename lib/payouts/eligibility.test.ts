import { describe, expect, it } from "vitest";
import { createPayoutEligibilityService } from "./eligibility";

const OWNER = { id: "00000000-0000-0000-0000-000000000101", role: "operator" as const };
const ENTRANT = { id: "00000000-0000-0000-0000-000000000202", role: "entrant" as const };

const completeReconciledSnapshot = () => ({
  competition_id: "competition-1",
  submission_id: "submission-1",
  ownership: { reconciled: true, entrant_id: ENTRANT.id },
  final_result: { final: true, rank: 1, score: 99.5, judge_revision: "judge-r7" },
  trace_artifact: {
    state: "verified", sha256: "a".repeat(64), scan_revision: "scan-r3", policy_compliant: true,
  },
  payout_profile: {
    provider: "external", verification_method: "eip191", chain_id: 1,
    address: "0x52908400098527886E0F7030069857D2E4169EE7", verified_at: "2026-08-02T12:00:00.000Z",
    effective: true,
  },
});

describe("payout eligibility freeze service", () => {
  it("allows only an operator to close a competition and freezes one deterministic, complete cutoff row", async () => {
    const service = createPayoutEligibilityService({} as never, {
      now: () => new Date("2026-08-03T12:00:00.000Z"),
      loadCompetitionSnapshot: async () => [completeReconciledSnapshot()],
    });
    await expect(service.freezeCompetition({ actor: ENTRANT, competition_id: "competition-1" }))
      .resolves.toEqual({ ok: false, error: { code: "operator_required" } });

    const first = await service.freezeCompetition({ actor: OWNER, competition_id: "competition-1" });
    expect(first).toEqual({
      ok: true,
      freezes: [expect.objectContaining({
        competition_id: "competition-1", submission_id: "submission-1", entrant_id: ENTRANT.id,
        status: "eligible", reason_code: "eligible", cutoff_at: "2026-08-03T12:00:00.000Z",
        result_rank: 1, result_score: 99.5, judge_revision: "judge-r7", trace_sha256: "a".repeat(64),
        trace_scan_revision: "scan-r3", payout_chain_id: 1,
      })],
    });
    expect(first.ok && Object.isFrozen(first.freezes[0])).toBe(true);
    await expect(service.freezeCompetition({ actor: OWNER, competition_id: "competition-1" })).resolves.toEqual(first);
  });

  it.each([
    ["ownership_unreconciled", { ownership: { reconciled: false, entrant_id: ENTRANT.id } }],
    ["final_result_missing", { final_result: { final: false, rank: null, score: null, judge_revision: null } }],
    ["trace_not_policy_compliant", { trace_artifact: { state: "verified", sha256: "a".repeat(64), scan_revision: "scan-r3", policy_compliant: false } }],
    ["payout_profile_not_effective", { payout_profile: { ...completeReconciledSnapshot().payout_profile, effective: false } }],
  ])("fails closed with %s for an incomplete or unsafe cutoff snapshot", async (reason_code, patch) => {
    const service = createPayoutEligibilityService({} as never, {
      loadCompetitionSnapshot: async () => [{ ...completeReconciledSnapshot(), ...patch }],
    });
    await expect(service.freezeCompetition({ actor: OWNER, competition_id: "competition-1" }))
      .resolves.toEqual({ ok: true, freezes: [expect.objectContaining({ status: "ineligible", reason_code })] });
  });

  it("aborts without creating any row when the Blob-backed snapshot is partial or stale", async () => {
    const writes: unknown[] = [];
    const service = createPayoutEligibilityService({ insert: async (row: unknown) => writes.push(row) } as never, {
      loadCompetitionSnapshot: async () => ({ state: "partial_or_stale" as const, retry_after: "2026-08-03T12:01:00.000Z" }),
    });
    await expect(service.freezeCompetition({ actor: OWNER, competition_id: "competition-1" }))
      .resolves.toEqual({ ok: false, error: { code: "snapshot_unavailable" } });
    expect(writes).toEqual([]);
  });

  it("lets an MCP caller read only its own safe entry and provides no settlement capability", async () => {
    const service = createPayoutEligibilityService({} as never, {
      loadOwnFreeze: async ({ entrant_id }: { entrant_id: string }) => entrant_id === ENTRANT.id
        ? { ...completeReconciledSnapshot(), entrant_id: ENTRANT.id, status: "eligible", reason_code: "eligible" }
        : null,
    });
    await expect(service.getOwnEligibility({ actor: ENTRANT, competition_id: "competition-1", submission_id: "submission-1" }))
      .resolves.toEqual({ ok: true, eligibility: expect.objectContaining({ entrant_id: ENTRANT.id, status: "eligible" }) });
    expect(Object.keys(service)).not.toEqual(expect.arrayContaining([
      "transfer", "pay", "sendPayment", "createSettlement", "signTransaction",
    ]));
  });

  it("persists a versioned complete evidence snapshot, not only denormalized columns", async () => {
    let persistedSnapshot: unknown;
    const sql = {
      async query<Row>(statement: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
        if (statement.startsWith("INSERT")) {
          persistedSnapshot = JSON.parse(String(params[9]));
          return { rows: [] };
        }
        return { rows: [{
          id: "00000000-0000-0000-0000-000000000701", competition_id: "competition-1", submission_id: "submission-1",
          entrant_id: ENTRANT.id, status: "eligible", reason_code: "eligible", policy_version: "policy-2026-08",
          cutoff_at: "2026-08-03T12:00:00.000Z", result_rank: 1, result_score: 99.5, judge_revision: "judge-r7",
          trace_sha256: "a".repeat(64), trace_scan_revision: "scan-r3", payout_address: completeReconciledSnapshot().payout_profile.address,
          payout_chain_id: 1, payout_profile_verified_at: "2026-08-02T12:00:00.000Z",
        }] as Row[] };
      },
    };
    const service = createPayoutEligibilityService(sql, {
      now: () => new Date("2026-08-03T12:00:00.000Z"),
      policyVersion: "policy-2026-08",
      loadCompetitionSnapshot: async () => [completeReconciledSnapshot()],
    });

    await expect(service.freezeCompetition({ actor: OWNER, competition_id: "competition-1" })).resolves.toMatchObject({ ok: true });
    expect(persistedSnapshot).toEqual(expect.objectContaining({
      schema_version: "payout-eligibility.v1",
      policy_version: "policy-2026-08",
      ownership: completeReconciledSnapshot().ownership,
      final_result: completeReconciledSnapshot().final_result,
      trace_artifact: completeReconciledSnapshot().trace_artifact,
      payout_profile: completeReconciledSnapshot().payout_profile,
    }));
  });

  it("rolls back the complete close-generation batch when a later immutable freeze write fails, then permits a clean retry", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    let failSecondWrite = true;
    let firstWriteComplete!: () => void;
    const firstWritten = new Promise<void>((resolve) => { firstWriteComplete = resolve; });
    const sql = {
      transaction: async <Value>(work: (tx: typeof sql) => Promise<Value>) => work(sql),
      async query<Row>(statement: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
        if (statement.startsWith("INSERT INTO payout_eligibility_freezes")) {
          const submissionId = String(params[2]);
          if (submissionId === "submission-2" && failSecondWrite) {
            await firstWritten;
            throw new Error("injected second immutable freeze failure");
          }
          rows.set(submissionId, {
            id: params[0], competition_id: params[1], submission_id: submissionId, entrant_id: params[3],
            status: params[5], reason_code: params[6], policy_version: params[7], cutoff_at: params[8],
            result_rank: params[10], result_score: params[11], judge_revision: params[12], trace_sha256: params[13],
            trace_scan_revision: params[14], payout_address: params[15], payout_chain_id: params[16], payout_profile_verified_at: params[17],
          });
          if (submissionId === "submission-1") firstWriteComplete();
          return { rows: [] as Row[] };
        }
        const row = rows.get(String(params[1]));
        return { rows: row ? [row as Row] : [] };
      },
    };
    const snapshot = [
      completeReconciledSnapshot(),
      { ...completeReconciledSnapshot(), submission_id: "submission-2" },
    ];
    const service = createPayoutEligibilityService(sql, {
      now: () => new Date("2026-08-03T12:00:00.000Z"),
      loadCompetitionSnapshot: async () => snapshot,
    });

    await expect(service.freezeCompetition({ actor: OWNER, competition_id: "competition-1" }))
      .rejects.toThrow("injected second immutable freeze failure");
    const leftoverAfterFailedBatch = [...rows.keys()];

    failSecondWrite = false;
    await expect(service.freezeCompetition({ actor: OWNER, competition_id: "competition-1" }))
      .resolves.toMatchObject({ ok: true, freezes: [{ submission_id: "submission-1" }, { submission_id: "submission-2" }] });
    expect(leftoverAfterFailedBatch).toEqual([]);
  });
});
