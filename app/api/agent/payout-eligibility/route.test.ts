import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ authenticateAgentSession: vi.fn(), getOwnPayoutEligibility: vi.fn() }));
vi.mock("@/lib/agent-network-runtime", () => ({ getAgentNetworkRuntime: () => runtime }));
import { GET } from "./route";

const actor = { id: "00000000-0000-0000-0000-000000000101", github_login: "alice" };
const request = (query = "competition_id=competition-1&submission_id=submission-1") => new NextRequest(`http://localhost/api/agent/payout-eligibility?${query}`, { headers: { authorization: "Bearer scoped-session" } });

describe("GET /api/agent/payout-eligibility", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.authenticateAgentSession.mockResolvedValue({ ok: true, actor });
    runtime.getOwnPayoutEligibility.mockResolvedValue({ ok: true, eligibility: {
      entrant_id: actor.id, competition_id: "competition-1", submission_id: "submission-1", status: "eligible", reason_code: "eligible",
      cutoff_at: "2026-08-03T12:00:00.000Z", trace_sha256: "a".repeat(64), payout_chain_id: 1,
    } });
  });

  it("requires payouts:read and returns only a safe entry belonging to the signed caller", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ eligibility: expect.objectContaining({ entrant_id: actor.id, status: "eligible", payout_chain_id: 1 }) });
    expect(runtime.authenticateAgentSession).toHaveBeenCalledWith(expect.any(NextRequest), { requiredScopes: ["payouts:read"] });
    expect(runtime.getOwnPayoutEligibility).toHaveBeenCalledWith({ actor, competition_id: "competition-1", submission_id: "submission-1" });
  });

  it.each(["", "competition_id=competition-1", "competition_id=x&submission_id=y&entrant_id=other"]) ("rejects non-exact caller-controlled queries: %s", async (query) => {
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "invalid_query" } });
    expect(runtime.getOwnPayoutEligibility).not.toHaveBeenCalled();
  });

  it("returns an indistinguishable not_found when the runtime refuses a cross-owner snapshot", async () => {
    runtime.getOwnPayoutEligibility.mockResolvedValue({ ok: false, error: { code: "not_found" } });

    const response = await GET(request());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: { code: "not_found" } });
    expect(runtime.getOwnPayoutEligibility).toHaveBeenCalledWith({ actor, competition_id: "competition-1", submission_id: "submission-1" });
  });

  it("does not turn an eligibility read failure into a payment capability", async () => {
    runtime.getOwnPayoutEligibility.mockResolvedValue({ ok: false, error: { code: "unavailable" } });

    const response = await GET(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: { code: "snapshot_unavailable" } });
  });

  it.each([
    ["unauthenticated", 401, "unauthenticated"], ["forbidden", 403, "insufficient_scope"], ["session_unavailable", 503, "session_unavailable"],
  ])("fails closed when session authentication is %s", async (code, status, publicCode) => {
    runtime.authenticateAgentSession.mockResolvedValueOnce({ ok: false, error: { code } });
    const response = await GET(request());
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code: publicCode } });
    expect(runtime.getOwnPayoutEligibility).not.toHaveBeenCalled();
  });

  it("maps runtime failures and overlong identifiers to safe, bounded errors", async () => {
    runtime.getOwnPayoutEligibility.mockRejectedValueOnce(new Error("database details"));
    const unavailable = await GET(request());
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: { code: "snapshot_unavailable" } });
    const tooLong = await GET(request(`competition_id=${"c".repeat(257)}&submission_id=submission-1`));
    expect(tooLong.status).toBe(400);
    expect(runtime.getOwnPayoutEligibility).toHaveBeenCalledTimes(1);
  });
});
