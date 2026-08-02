import { describe, expect, it, vi } from "vitest";

import { createAgentNetworkRuntime } from "./agent-network-runtime";

const ALICE = {
  id: "00000000-0000-0000-0000-000000000101",
  github_id: 101,
  github_login: "alice",
  authenticated_at: "2026-08-03T12:00:00.000Z",
  session_id: "00000000-0000-0000-0000-000000000501",
};
const BOB = { ...ALICE, id: "00000000-0000-0000-0000-000000000202", github_id: 202, github_login: "bob" };

function fixture(eligibility?: { getOwnEligibility(input: unknown): Promise<unknown> }) {
  const services = {
    repositories: {
      entrants: { upsert: vi.fn() },
      sessions: { create: vi.fn(), isAuthenticated: vi.fn(), touch: vi.fn() },
      memberships: { set: vi.fn() },
    },
    chat: { list: vi.fn(), post: vi.fn() },
    ...(eligibility ? { eligibility } : {}),
  };
  const runtime = (createAgentNetworkRuntime as any)({
    services,
    storage: { getCompetition: vi.fn() },
    tokenConfiguration: { issuer: "harness-arena", audience: "harness-arena-mcp", keyId: "key-1" },
  });
  return { runtime, services };
}

describe("agent network payout-eligibility runtime boundary", () => {
  it("reads only the signed entrant's immutable eligibility snapshot through the composed eligibility repository", async () => {
    const eligibility = {
      getOwnEligibility: vi.fn().mockResolvedValue({
        ok: true,
        eligibility: { entrant_id: ALICE.id, competition_id: "competition-1", submission_id: "submission-1", status: "eligible" },
      }),
    };
    const { runtime } = fixture(eligibility);

    await expect(runtime.getOwnPayoutEligibility({ actor: ALICE, competition_id: "competition-1", submission_id: "submission-1" }))
      .resolves.toEqual({ ok: true, eligibility: expect.objectContaining({ entrant_id: ALICE.id, status: "eligible" }) });
    expect(eligibility.getOwnEligibility).toHaveBeenCalledWith({
      actor: { id: ALICE.id },
      competition_id: "competition-1",
      submission_id: "submission-1",
    });
    expect(JSON.stringify(eligibility.getOwnEligibility.mock.calls)).not.toContain(ALICE.github_login);
    expect(JSON.stringify(eligibility.getOwnEligibility.mock.calls)).not.toContain(ALICE.session_id);
  });

  it("turns a foreign or missing immutable row into not_found without exposing ownership", async () => {
    const eligibility = {
      // A database adapter must not be able to make a cross-owner record observable,
      // even if it returns an inconsistent row.
      getOwnEligibility: vi.fn().mockResolvedValue({
        ok: true,
        eligibility: { entrant_id: BOB.id, competition_id: "competition-1", submission_id: "submission-1", status: "eligible" },
      }),
    };
    const { runtime } = fixture(eligibility);

    await expect(runtime.getOwnPayoutEligibility({ actor: ALICE, competition_id: "competition-1", submission_id: "submission-1" }))
      .resolves.toEqual({ ok: false, error: { code: "not_found" } });
  });

  it("fails closed when eligibility is absent or its read throws, and never exposes a payment mutation", async () => {
    const absent = fixture();
    await expect(absent.runtime.getOwnPayoutEligibility({ actor: ALICE, competition_id: "competition-1", submission_id: "submission-1" }))
      .resolves.toEqual({ ok: false, error: { code: "unavailable" } });

    const failing = fixture({ getOwnEligibility: vi.fn().mockRejectedValue(new Error("database unavailable")) });
    await expect(failing.runtime.getOwnPayoutEligibility({ actor: ALICE, competition_id: "competition-1", submission_id: "submission-1" }))
      .resolves.toEqual({ ok: false, error: { code: "unavailable" } });
    expect(Object.keys(failing.runtime).filter((name) => /pay|award|transfer|send/i.test(name))).toEqual(["getOwnPayoutEligibility"]);
  });
});
