import { describe, expect, it, vi } from "vitest";
import { HarnessArenaClient } from "./client.js";
import { toolDefinitions } from "./server.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const credentials = () => ({ get: vi.fn().mockResolvedValue({ token: "arena-session", github_login: "octo", expires_at: "2030-01-01T00:00:00Z" }), set: vi.fn() });
const address = "0x52908400098527886E0F7030069857D2E4169EE7";
const signature = `0x${"a".repeat(130)}`;

describe("external Ethereum payout MCP tools", () => {
  it("uses authenticated exact payout-profile HTTP mappings", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(201, { challenge: { id: "challenge-1", address, chain_id: 1 } }))
      .mockResolvedValueOnce(json(200, { profile: { provider: "external", address, chain_id: 1 } }))
      .mockResolvedValueOnce(json(200, { profile: null }));
    const client = new HarnessArenaClient({ baseUrl: "https://arena.example.test", credentials: credentials(), fetch: fetcher });

    await client.prepareExternalPayoutAddress({ address });
    await client.verifyExternalPayoutAddress({ challenge_id: "challenge-1", signature, consent_version: "payout-address.v1", idempotency_key: "verify-1" });
    await client.getPayoutProfile();

    expect(fetcher.mock.calls.map(([url]) => url.toString())).toEqual([
      "https://arena.example.test/api/agent/payout-profile/challenge",
      "https://arena.example.test/api/agent/payout-profile/verify",
      "https://arena.example.test/api/agent/payout-profile",
    ]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer arena-session" }, body: JSON.stringify({ address }) });
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer arena-session" }, body: JSON.stringify({ challenge_id: "challenge-1", signature, consent_version: "payout-address.v1", idempotency_key: "verify-1" }) });
    expect(fetcher.mock.calls[2][1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer arena-session" } });
  });

  it("exposes strict schemas and ownership-only Ethereum-mainnet wording without payment or key authority", async () => {
    const client = {
      prepareExternalPayoutAddress: vi.fn().mockResolvedValue({ challenge: { id: "challenge-1" } }),
      verifyExternalPayoutAddress: vi.fn().mockResolvedValue({ profile: { address, chain_id: 1 } }),
      getPayoutProfile: vi.fn().mockResolvedValue({ profile: null }),
    };
    const definitions = toolDefinitions(client as never);
    const prepare = definitions.prepare_external_payout_address;
    const verify = definitions.verify_external_payout_address;
    const profile = definitions.get_payout_profile;
    const verification = { challenge_id: "challenge-1", signature, consent_version: "payout-address.v1", idempotency_key: "verify-1" };

    expect(prepare.inputSchema.safeParse({ address }).success).toBe(true);
    expect(prepare.inputSchema.safeParse({ address, reauthenticated_at: "client-controlled" }).success).toBe(false);
    expect(prepare.inputSchema.safeParse({ address: "not-an-address" }).success).toBe(false);
    expect(verify.inputSchema.safeParse(verification).success).toBe(true);
    expect(verify.inputSchema.safeParse({ ...verification, signature: "" }).success).toBe(false);
    expect(verify.inputSchema.safeParse({ ...verification, consent_version: "x".repeat(129) }).success).toBe(false);
    expect(verify.inputSchema.safeParse({ ...verification, extra: true }).success).toBe(false);
    expect(profile.inputSchema.safeParse({}).success).toBe(true);
    expect(profile.inputSchema.safeParse({ extra: true }).success).toBe(false);

    await prepare.handler({ address });
    await verify.handler(verification);
    await profile.handler({});
    expect(client.prepareExternalPayoutAddress).toHaveBeenCalledWith({ address });
    expect(client.verifyExternalPayoutAddress).toHaveBeenCalledWith(verification);
    expect(client.getPayoutProfile).toHaveBeenCalledOnce();

    for (const tool of [prepare, verify, profile]) {
      expect(tool.description).toMatch(/Ethereum mainnet/i);
      expect(tool.description).toMatch(/user-owned|your own/i);
      expect(tool.description).toMatch(/cannot send|never sends/i);
      expect(tool.description).not.toMatch(/private key/i);
    }
  });
});
