import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  authenticateAgentSession: vi.fn(),
  revokeCurrentAgentSession: vi.fn(),
}));

vi.mock("@/lib/agent-network-runtime", () => ({ getAgentNetworkRuntime: () => runtime }));

import { POST } from "./route";

const actor = { id: "entrant-private-id", github_id: 101, github_login: "alice", authenticated_at: "2026-08-02T12:00:00.000Z", session_id: "session-current" };
const post = (body: unknown = {}) => new NextRequest("http://localhost/api/agent/sessions/current/revoke", {
  method: "POST", headers: { authorization: "Bearer scoped-session", "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("POST /api/agent/sessions/current/revoke", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.authenticateAgentSession.mockResolvedValue({ ok: true, actor });
    runtime.revokeCurrentAgentSession.mockResolvedValue({ revoked: true });
  });

  it("requires sessions:write and idempotently revokes only the authenticated current session", async () => {
    const first = await POST(post());
    const second = await POST(post());

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ revoked: true });
    await expect(second.json()).resolves.toEqual({ revoked: true });
    expect(runtime.authenticateAgentSession).toHaveBeenCalledWith(expect.any(NextRequest), { requiredScopes: ["sessions:write"] });
    expect(runtime.revokeCurrentAgentSession).toHaveBeenCalledWith({ actor });
  });

  it.each([
    [post({ extra: true }), 400],
    [new NextRequest("http://localhost/api/agent/sessions/current/revoke", { method: "POST", headers: { authorization: "Bearer scoped-session", "content-type": "application/json", "content-length": String(1_048_577) }, body: JSON.stringify({ body: "x".repeat(1_048_577) }) }), 413],
  ])("rejects a non-empty or oversized body before it reaches the facade", async (request, status) => {
    const response = await POST(request);
    expect(response.status).toBe(status);
    expect(runtime.revokeCurrentAgentSession).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", 401, "unauthenticated"],
    ["forbidden", 403, "insufficient_scope"],
    ["session_unavailable", 503, "session_unavailable"],
  ])("returns stable %s errors without revoking", async (reason, status, code) => {
    runtime.authenticateAgentSession.mockResolvedValueOnce({ ok: false, error: { code: reason } });
    const response = await POST(post());
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code } });
    expect(runtime.revokeCurrentAgentSession).not.toHaveBeenCalled();
  });

  it("maps malformed JSON and a revocation backend failure to stable errors", async () => {
    const malformed = await POST(new NextRequest("http://localhost/api/agent/sessions/current/revoke", {
      method: "POST", headers: { authorization: "Bearer scoped-session", "content-type": "application/json" }, body: "{",
    }));
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: { code: "invalid_body" } });

    runtime.revokeCurrentAgentSession.mockRejectedValueOnce(new Error("database unavailable"));
    const unavailable = await POST(post());
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: { code: "sessions_unavailable" } });
  });

  it("bounds malformed, absent, and streamed bodies before revoking the current session", async () => {
    const request = (headers: Record<string, string>, body?: string) => new NextRequest("http://localhost/api/agent/sessions/current/revoke", {
      method: "POST",
      headers: { authorization: "Bearer scoped-session", "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body }),
    });
    for (const [candidate, status, code] of [
      [request({ "content-length": "01" }, "{}"), 400, "invalid_body"],
      [request({ "content-length": "999999999999999999999999999999" }, "{}"), 400, "invalid_body"],
      [request({}), 400, "invalid_body"],
      [request({}, "x".repeat(1_048_577)), 413, "body_too_large"],
    ] as const) {
      const response = await POST(candidate);
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error: { code } });
    }
    expect(runtime.revokeCurrentAgentSession).not.toHaveBeenCalled();
  });
});
