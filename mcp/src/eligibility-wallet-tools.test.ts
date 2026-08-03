import { describe, expect, it, vi } from "vitest";
import { HarnessArenaClient } from "./client.js";
import { toolDefinitions } from "./server.js";

const credentials = () => ({ get: vi.fn().mockResolvedValue({ token: "arena-session", github_login: "octo", expires_at: "2030-01-01T00:00:00Z" }), set: vi.fn() });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("payout eligibility and wallet MCP tools", () => {
  it("maps own eligibility to the authenticated, exact GET route and maps stable HTTP failures", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(200, { eligibility: { submission_id: "submission-1", status: "eligible" } }))
      .mockResolvedValueOnce(json(503, { error: { code: "snapshot_unavailable" } }));
    const client = new HarnessArenaClient({ baseUrl: "https://arena.example.test", credentials: credentials(), fetch: fetcher });
    await expect(client.getPayoutEligibility({ competition_id: "competition-1", submission_id: "submission-1" }))
      .resolves.toEqual({ eligibility: { submission_id: "submission-1", status: "eligible" } });
    await expect(client.getPayoutEligibility({ competition_id: "competition-1", submission_id: "submission-1" }))
      .rejects.toMatchObject({ code: "snapshot_unavailable", status: 503, retryable: true });
    expect(fetcher.mock.calls[0][0].toString()).toBe("https://arena.example.test/api/agent/payout-eligibility?competition_id=competition-1&submission_id=submission-1");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer arena-session" } });
  });

  it("exposes strict, owner-only eligibility and a fixed-mainnet user-owned wallet ensure tool", async () => {
    const client = {
      getPayoutEligibility: vi.fn().mockResolvedValue({ eligibility: null }),
      ensurePayoutWallet: vi.fn().mockResolvedValue({ error: { code: "feature_unavailable" } }),
    };
    const definitions = toolDefinitions(client as never);
    const eligibility = definitions.get_payout_eligibility;
    const wallet = definitions.ensure_payout_wallet;
    expect(eligibility.inputSchema.safeParse({ competition_id: "competition-1", submission_id: "submission-1" }).success).toBe(true);
    expect(eligibility.inputSchema.safeParse({ competition_id: "competition-1", submission_id: "submission-1", entrant_id: "other" }).success).toBe(false);
    expect(wallet.inputSchema.safeParse({}).success).toBe(true);
    expect(wallet.inputSchema.safeParse({ chain_id: 137 }).success).toBe(false);
    await eligibility.handler({ competition_id: "competition-1", submission_id: "submission-1" });
    await wallet.handler({});
    expect(client.getPayoutEligibility).toHaveBeenCalledWith({ competition_id: "competition-1", submission_id: "submission-1" });
    expect(client.ensurePayoutWallet).toHaveBeenCalledWith({});
    for (const tool of [eligibility, wallet]) {
      expect(tool.description).toMatch(/your own|owner-only|user-owned/i);
      expect(tool.description).toMatch(/Ethereum mainnet/i);
      expect(tool.description).toMatch(/cannot send|never sends|no payments/i);
      expect(tool.description).not.toMatch(/private key|sign transaction/i);
    }
  });
});
