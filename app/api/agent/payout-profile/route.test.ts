import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  authenticateAgentSession: vi.fn(),
  prepareExternalPayoutAddress: vi.fn(),
  verifyExternalPayoutAddress: vi.fn(),
  getPayoutProfile: vi.fn(),
}));

vi.mock("@/lib/agent-network-runtime", () => ({ getAgentNetworkRuntime: () => runtime }));

import { POST as prepare } from "./challenge/route";
import { GET } from "./route";
import { POST as verify } from "./verify/route";

const actor = {
  id: "00000000-0000-0000-0000-000000000101",
  github_id: 101,
  github_login: "alice",
  authenticated_at: "2026-08-02T12:00:00.000Z",
  session_id: "session-101",
};
const address = "0x52908400098527886E0F7030069857D2E4169EE7";
const signature = `0x${"a".repeat(130)}`;
const challenge = {
  id: "challenge-1",
  address,
  chain_id: 1,
  expires_at: "2026-08-02T12:10:00.000Z",
  message: "harness-arena payout address verification",
};
const profile = {
  provider: "external",
  address,
  chain_id: 1,
  verification_method: "eip191",
  consent_version: "payout-address.v1",
  verified_at: "2026-08-02T12:01:00.000Z",
  change_effective_at: "2026-08-02T12:01:00.000Z",
  effective: true,
};
const headers = { authorization: "Bearer scoped-session", "content-type": "application/json" };
const post = (path: string, body: unknown, extraHeaders: HeadersInit = {}) => new NextRequest(`http://localhost${path}`, {
  method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body),
});
const get = () => new NextRequest("http://localhost/api/agent/payout-profile", { headers: { authorization: "Bearer scoped-session" } });

describe("external Ethereum payout-profile HTTP contracts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.authenticateAgentSession.mockResolvedValue({ ok: true, actor });
    runtime.prepareExternalPayoutAddress.mockResolvedValue({ ok: true, challenge });
    runtime.verifyExternalPayoutAddress.mockResolvedValue({ ok: true, profile });
    runtime.getPayoutProfile.mockResolvedValue({ ok: true, profile: null });
  });

  it("prepares a fixed-mainnet challenge using only the signed actor authentication", async () => {
    const response = await prepare(post("/api/agent/payout-profile/challenge", { address }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ challenge });
    expect(runtime.authenticateAgentSession).toHaveBeenCalledWith(expect.any(NextRequest), { requiredScopes: ["payouts:write"] });
    expect(runtime.prepareExternalPayoutAddress).toHaveBeenCalledWith({ actor, address });
    expect(runtime.prepareExternalPayoutAddress.mock.calls[0][0]).not.toHaveProperty("reauthenticated_at");
    expect(challenge).toEqual(expect.objectContaining({ chain_id: 1 }));
    expect(JSON.stringify(challenge)).not.toContain(actor.authenticated_at);
  });

  it("verifies an exact, bounded request and returns only a safe fixed-mainnet profile", async () => {
    const response = await verify(post("/api/agent/payout-profile/verify", {
      challenge_id: challenge.id,
      signature,
      consent_version: "payout-address.v1",
      idempotency_key: "payout-verify-1",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ profile });
    expect(runtime.authenticateAgentSession).toHaveBeenCalledWith(expect.any(NextRequest), { requiredScopes: ["payouts:write"] });
    expect(runtime.verifyExternalPayoutAddress).toHaveBeenCalledWith({
      actor, challenge_id: challenge.id, signature, consent_version: "payout-address.v1", idempotency_key: "payout-verify-1",
    });
    expect(profile).toEqual(expect.objectContaining({ provider: "external", chain_id: 1, verification_method: "eip191" }));
    expect(JSON.stringify(profile)).not.toMatch(/private.?key|database|entrant_id/i);
  });

  it("reads only the signed caller's payout profile with the payouts read scope", async () => {
    runtime.getPayoutProfile.mockResolvedValueOnce({ ok: true, profile });
    const response = await GET(get());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ profile });
    expect(runtime.authenticateAgentSession).toHaveBeenCalledWith(expect.any(NextRequest), { requiredScopes: ["payouts:read"] });
    expect(runtime.getPayoutProfile).toHaveBeenCalledWith({ actor });
  });

  it.each([
    [{}, "invalid_body"],
    [{ address: "not-an-ethereum-address" }, "invalid_body"],
    [{ address, reauthenticated_at: "2099-01-01T00:00:00.000Z" }, "invalid_body"],
    [{ challenge_id: challenge.id, signature, consent_version: "payout-address.v1" }, "invalid_body"],
    [{ challenge_id: challenge.id, signature, consent_version: "payout-address.v1", idempotency_key: "retry", extra: true }, "invalid_body"],
  ])("rejects exact input before invoking a payout facade: %o", async (body, code) => {
    const endpoint = "address" in body ? prepare : verify;
    const path = "address" in body ? "/api/agent/payout-profile/challenge" : "/api/agent/payout-profile/verify";
    const response = await endpoint(post(path, body));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code } });
    expect(runtime.prepareExternalPayoutAddress).not.toHaveBeenCalled();
    expect(runtime.verifyExternalPayoutAddress).not.toHaveBeenCalled();
  });

  it("caps untrusted JSON at 1 MiB and never logs address, signature, or database details", async () => {
    const privateAddress = "0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF";
    const privateSignature = `0xNEVER-LOG-SIGNATURE-${"x".repeat(1_048_576)}`;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await verify(post("/api/agent/payout-profile/verify", {
      challenge_id: "challenge-1", signature: privateSignature, consent_version: "payout-address.v1", idempotency_key: "large",
    }, { "content-length": String(1_048_577) }));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: { code: "body_too_large" } });
    runtime.verifyExternalPayoutAddress.mockRejectedValueOnce(new Error(`postgres://private ${privateAddress} ${signature}`));
    const unavailable = await verify(post("/api/agent/payout-profile/verify", {
      challenge_id: "challenge-1", signature, consent_version: "payout-address.v1", idempotency_key: "unavailable",
    }));
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: { code: "payout_profile_unavailable" } });
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).not.toContain(privateAddress);
    expect(logged).not.toContain("NEVER-LOG-SIGNATURE");
    expect(logged).not.toContain(signature);
    expect(logged).not.toContain("postgres://");
    spy.mockRestore();
  });

  it("maps stable authentication, replay, conflict, recent-auth, rate, and unavailable errors", async () => {
    runtime.authenticateAgentSession.mockResolvedValueOnce({ ok: false, error: { code: "unauthenticated" } });
    expect((await prepare(post("/api/agent/payout-profile/challenge", { address }))).status).toBe(401);
    runtime.authenticateAgentSession.mockResolvedValueOnce({ ok: false, error: { code: "forbidden" } });
    expect((await GET(get())).status).toBe(403);

    for (const [serviceCode, status, publicCode] of [
      ["challenge_consumed", 409, "challenge_consumed"], ["idempotency_conflict", 409, "idempotency_conflict"],
      ["recent_authentication_required", 403, "recent_authentication_required"], ["rate_limited", 429, "rate_limited"], ["unavailable", 503, "payout_profile_unavailable"],
    ] as const) {
      runtime.verifyExternalPayoutAddress.mockResolvedValueOnce({ ok: false, error: { code: serviceCode } });
      const response = await verify(post("/api/agent/payout-profile/verify", { challenge_id: challenge.id, signature, consent_version: "payout-address.v1", idempotency_key: `case-${serviceCode}` }));
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error: { code: publicCode } });
    }
  });
});
