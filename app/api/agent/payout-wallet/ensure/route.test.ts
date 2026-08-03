import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ authenticateAgentSession: vi.fn(), ensurePayoutWallet: vi.fn() }));
vi.mock("@/lib/agent-network-runtime", () => ({ getAgentNetworkRuntime: () => runtime }));
import { POST } from "./route";

const actor = { id: "00000000-0000-0000-0000-000000000101", github_login: "alice" };
const request = () => new NextRequest("http://localhost/api/agent/payout-wallet/ensure", {
  method: "POST", headers: { authorization: "Bearer scoped-session", "content-type": "application/json" }, body: "{}",
});

describe("POST /api/agent/payout-wallet/ensure", () => {
  beforeEach(() => { vi.resetAllMocks(); runtime.authenticateAgentSession.mockResolvedValue({ ok: true, actor }); });

  it("fails closed as feature_unavailable with zero provider calls when Privy POC/config/flag is absent", async () => {
    const response = await POST(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: { code: "feature_unavailable" } });
    expect(runtime.authenticateAgentSession).toHaveBeenCalledWith(expect.any(NextRequest), { requiredScopes: ["payouts:write"] });
    expect(runtime.ensurePayoutWallet).not.toHaveBeenCalled();
  });

  it("has no request-controlled chain, address, payment, or provider fields", async () => {
    const response = await POST(new NextRequest("http://localhost/api/agent/payout-wallet/ensure", {
      method: "POST", headers: { authorization: "Bearer scoped-session", "content-type": "application/json" },
      body: JSON.stringify({ chain_id: 137, payment: true, provider: "privy" }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "invalid_body" } });
    expect(runtime.ensurePayoutWallet).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", 401, "unauthenticated"],
    ["forbidden", 403, "insufficient_scope"],
    ["session_unavailable", 503, "session_unavailable"],
  ])("fails closed for %s authentication before parsing or provisioning", async (reason, status, code) => {
    runtime.authenticateAgentSession.mockResolvedValueOnce({ ok: false, error: { code: reason } });
    const response = await POST(request());
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code } });
    expect(runtime.ensurePayoutWallet).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON without invoking any wallet provider seam", async () => {
    const response = await POST(new NextRequest("http://localhost/api/agent/payout-wallet/ensure", {
      method: "POST", headers: { authorization: "Bearer scoped-session", "content-type": "application/json" }, body: "{",
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "invalid_body" } });
    expect(runtime.ensurePayoutWallet).not.toHaveBeenCalled();
  });

  it("rejects an authenticated oversized body before buffering or provisioning", async () => {
    const response = await POST(new NextRequest("http://localhost/api/agent/payout-wallet/ensure", {
      method: "POST",
      headers: {
        authorization: "Bearer scoped-session",
        "content-type": "application/json",
        "content-length": String(1_048_577),
      },
      body: "{}",
    }));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: { code: "body_too_large" } });
    expect(runtime.ensurePayoutWallet).not.toHaveBeenCalled();
  });
});
