import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  authenticateAgentSession: vi.fn(),
  revokeAgentSession: vi.fn(),
}));

vi.mock("@/lib/agent-network-runtime", () => ({ getAgentNetworkRuntime: () => runtime }));

import { POST } from "./route";

const actor = { id: "entrant-alice", github_id: 101, github_login: "alice", authenticated_at: "2026-08-02T12:00:00.000Z", session_id: "session-current" };
const post = () => new NextRequest("http://localhost/api/agent/sessions/session-other/revoke", { method: "POST", headers: { authorization: "Bearer scoped-session", "content-type": "application/json" }, body: "{}" });
const context = (id = "session-other") => ({ params: Promise.resolve({ id }) });

describe("POST /api/agent/sessions/[id]/revoke", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.authenticateAgentSession.mockResolvedValue({ ok: true, actor });
    runtime.revokeAgentSession.mockResolvedValue({ ok: true, revoked: true });
  });

  it("requires sessions:write and passes the current actor so another entrant's session cannot be revoked", async () => {
    const response = await POST(post(), context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: true });
    expect(runtime.authenticateAgentSession).toHaveBeenCalledWith(expect.any(NextRequest), { requiredScopes: ["sessions:write"] });
    expect(runtime.revokeAgentSession).toHaveBeenCalledWith({ actor, session_id: "session-other" });
  });

  it.each(["", "x".repeat(257), "../session", "session other"]) ("rejects a non-canonical bounded session id: %j", async (id) => {
    const response = await POST(post(), context(id));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "invalid_session_id" } });
    expect(runtime.revokeAgentSession).not.toHaveBeenCalled();
  });

  it("does not reveal whether another entrant's session exists", async () => {
    runtime.revokeAgentSession.mockResolvedValueOnce({ ok: false, error: { code: "not_found" } });
    const response = await POST(post(), context("another-entrants-session"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: { code: "session_not_found" } });
  });

  it.each([
    ["unauthenticated", 401, "unauthenticated"],
    ["forbidden", 403, "insufficient_scope"],
    ["session_unavailable", 503, "session_unavailable"],
  ])("returns stable %s errors before resolving the target session", async (reason, status, code) => {
    runtime.authenticateAgentSession.mockResolvedValueOnce({ ok: false, error: { code: reason } });
    const response = await POST(post(), context());
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code } });
    expect(runtime.revokeAgentSession).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and hides revocation backend errors", async () => {
    const malformed = await POST(new NextRequest("http://localhost/api/agent/sessions/session-other/revoke", {
      method: "POST", headers: { authorization: "Bearer scoped-session", "content-type": "application/json" }, body: "{",
    }), context());
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: { code: "invalid_body" } });

    runtime.revokeAgentSession.mockRejectedValueOnce(new Error("database unavailable"));
    const unavailable = await POST(post(), context());
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: { code: "sessions_unavailable" } });
  });

  it("bounds declared and streamed request bodies before resolving the target session", async () => {
    const request = (headers: Record<string, string>, body?: string) => new NextRequest("http://localhost/api/agent/sessions/session-other/revoke", {
      method: "POST",
      headers: { authorization: "Bearer scoped-session", "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body }),
    });
    for (const [candidate, status, code] of [
      [request({ "content-length": "01" }, "{}"), 400, "invalid_body"],
      [request({ "content-length": "999999999999999999999999999999" }, "{}"), 400, "invalid_body"],
      [request({ "content-length": String(1_048_577) }, "{}"), 413, "body_too_large"],
      [request({}), 400, "invalid_body"],
      [request({}, "x".repeat(1_048_577)), 413, "body_too_large"],
    ] as const) {
      const response = await POST(candidate, context());
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error: { code } });
    }
    expect(runtime.revokeAgentSession).not.toHaveBeenCalled();
  });
});
