import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  authenticateAgentSession: vi.fn(),
  listAgentSessions: vi.fn(),
}));

vi.mock("@/lib/agent-network-runtime", () => ({ getAgentNetworkRuntime: () => runtime }));

import { GET } from "./route";

const actor = { id: "entrant-private-id", github_id: 101, github_login: "alice", authenticated_at: "2026-08-02T12:00:00.000Z", session_id: "session-current" };
const safeSession = { session_id: "session-current", authenticated_at: "2026-08-02T12:00:00.000Z", expires_at: "2026-09-01T12:00:00.000Z", last_active_at: "2026-08-02T12:01:00.000Z", current: true };
const request = () => new NextRequest("http://localhost/api/agent/sessions", { headers: { authorization: "Bearer scoped-session" } });

describe("GET /api/agent/sessions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.authenticateAgentSession.mockResolvedValue({ ok: true, actor });
    runtime.listAgentSessions.mockResolvedValue({ sessions: [safeSession] });
  });

  it("requires sessions:read and returns only the caller's safe session DTOs", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ sessions: [safeSession] });
    expect(runtime.authenticateAgentSession).toHaveBeenCalledWith(expect.any(NextRequest), { requiredScopes: ["sessions:read"] });
    expect(runtime.listAgentSessions).toHaveBeenCalledWith({ actor });
    expect(JSON.stringify(safeSession)).not.toMatch(/entrant-private-id|scoped-session|issuer|audience|key/i);
  });

  it.each([
    ["unauthenticated", 401, "unauthenticated"],
    ["forbidden", 403, "insufficient_scope"],
    ["session_unavailable", 503, "session_unavailable"],
  ])("returns stable %s errors without listing sessions", async (reason, status, code) => {
    runtime.authenticateAgentSession.mockResolvedValueOnce({ ok: false, error: { code: reason } });
    const response = await GET(request());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code } });
    expect(runtime.listAgentSessions).not.toHaveBeenCalled();
  });

  it("maps service failure to a stable response without logging session secrets", async () => {
    const secret = "NEVER-LOG-session-secret";
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runtime.listAgentSessions.mockRejectedValueOnce(new Error(`database unavailable ${secret}`));

    const response = await GET(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: { code: "sessions_unavailable" } });
    expect(spy.mock.calls.flat().join(" ")).not.toContain(secret);
    spy.mockRestore();
  });
});
