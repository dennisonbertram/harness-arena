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
});
