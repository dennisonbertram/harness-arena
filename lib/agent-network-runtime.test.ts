import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionTokenError } from "./agent-token";
import { createAgentNetworkRuntime } from "./agent-network-runtime";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const EXPIRES_AT = "2026-09-01T12:00:00.000Z";
const ACTOR = {
  entrantId: "00000000-0000-0000-0000-000000000101",
  githubId: 101,
  githubLogin: "alice",
  sessionId: "00000000-0000-0000-0000-000000000501",
  scopes: ["competitions:read", "chat:read", "chat:write"],
  authenticatedAt: NOW.toISOString(),
};

function fixture() {
  const entrants = { upsert: vi.fn().mockResolvedValue({ id: ACTOR.entrantId, githubId: "101", githubLogin: "alice" }) };
  const sessions = {
    create: vi.fn().mockImplementation(async (input) => ({ ...input, authenticatedAt: NOW.toISOString() })),
    isAuthenticated: vi.fn(),
    touch: vi.fn(),
  };
  const memberships = { set: vi.fn().mockResolvedValue({ competitionId: "live-cup", state: "active", joinedAt: NOW.toISOString() }) };
  const chat = {
    join: vi.fn().mockResolvedValue({ ok: true, membership: { competition_id: "live-cup", state: "active", joined_at: NOW.toISOString() } }),
    list: vi.fn().mockResolvedValue({ ok: true, page: { messages: [], next_cursor: null, has_more: false, high_water_mark: 0 } }),
    post: vi.fn().mockResolvedValue({ ok: true, message: { id: "message-1" } }),
  };
  const storage = { getCompetition: vi.fn().mockResolvedValue({ id: "live-cup", status: "live" }) };
  const tokens = {
    mint: vi.fn().mockResolvedValue("signed-scoped-token"),
    verify: vi.fn().mockResolvedValue(ACTOR),
  };
  const runtime = createAgentNetworkRuntime({
    services: { repositories: { entrants, sessions, memberships }, chat },
    storage,
    tokens,
    ids: { next: () => ACTOR.sessionId },
    now: () => NOW,
    tokenConfiguration: { issuer: "harness-arena", audience: "harness-arena-mcp", keyId: "key-1" },
  });
  return { runtime, entrants, sessions, memberships, chat, storage, tokens };
}

describe("agent network runtime facade", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists a 30-day, least-authority session before returning a scoped token", async () => {
    const { runtime, entrants, sessions, tokens } = fixture();
    const result = await runtime.issueScopedAgentSession({ githubId: 101, githubLogin: "Alice" });

    expect(entrants.upsert).toHaveBeenCalledWith({ githubId: "101", githubLogin: "Alice" });
    expect(sessions.create).toHaveBeenCalledWith({
      jti: ACTOR.sessionId,
      entrantId: ACTOR.entrantId,
      issuer: "harness-arena",
      audience: "harness-arena-mcp",
      keyId: "key-1",
      tokenVersion: 1,
      scopes: [
        "competitions:read", "competitions:write", "chat:read", "chat:write",
        "traces:read", "traces:write", "payouts:read", "payouts:write",
        "sessions:read", "sessions:write",
      ],
      expiresAt: EXPIRES_AT,
    });
    expect(tokens.mint).toHaveBeenCalledWith(
      { entrantId: ACTOR.entrantId, githubId: 101, githubLogin: "Alice" },
      {
        jti: ACTOR.sessionId,
        tokenVersion: 1,
        scopes: expect.arrayContaining(["competitions:read", "chat:write", "traces:write", "payouts:write", "sessions:write"]),
        authenticatedAt: NOW.toISOString(),
        expiresInSeconds: 30 * 24 * 60 * 60,
      },
    );
    expect(result).toEqual({ token: "signed-scoped-token", github_login: "Alice", expires_at: EXPIRES_AT });
    expect(Object.keys(result)).not.toEqual(expect.arrayContaining(["entrant_id", "jti", "issuer", "audience", "scopes"]));
  });

  it("rejects malformed bearer input before token verification and maps verifier failures to stable codes", async () => {
    const { runtime, tokens } = fixture();
    const missing = await runtime.authenticateAgentSession(new NextRequest("http://localhost"), { requiredScopes: ["chat:read"] });
    expect(missing).toEqual({ ok: false, error: { code: "unauthenticated" } });
    expect(tokens.verify).not.toHaveBeenCalled();

    const malformed = await runtime.authenticateAgentSession(new NextRequest("http://localhost", { headers: { authorization: "Basic secret" } }), { requiredScopes: ["chat:read"] });
    expect(malformed).toEqual({ ok: false, error: { code: "unauthenticated" } });

    tokens.verify.mockRejectedValueOnce(Object.assign(new Error("scope details"), { code: "insufficient_scope" }));
    const forbidden = await runtime.authenticateAgentSession(new NextRequest("http://localhost", { headers: { authorization: "Bearer token" } }), { requiredScopes: ["chat:write"] });
    expect(forbidden).toEqual({ ok: false, error: { code: "forbidden" } });

    tokens.verify.mockRejectedValueOnce(new Error("postgres://user:secret@host/db"));
    const unavailable = await runtime.authenticateAgentSession(new NextRequest("http://localhost", { headers: { authorization: "Bearer token" } }), { requiredScopes: ["chat:read"] });
    expect(unavailable).toEqual({ ok: false, error: { code: "session_unavailable" } });

    tokens.verify.mockRejectedValueOnce(Object.assign(new Error("repository down"), { code: "session_unavailable" }));
    await expect(runtime.authenticateAgentSession(new NextRequest("http://localhost", { headers: { authorization: "Bearer token" } }), { requiredScopes: [] }))
      .resolves.toEqual({ ok: false, error: { code: "session_unavailable" } });
    tokens.verify.mockRejectedValueOnce(new AgentSessionTokenError("expired"));
    await expect(runtime.authenticateAgentSession(new NextRequest("http://localhost", { headers: { authorization: "Bearer token" } }), { requiredScopes: [] }))
      .resolves.toEqual({ ok: false, error: { code: "unauthenticated" } });
    tokens.verify.mockRejectedValueOnce("non-error verifier failure");
    await expect(runtime.authenticateAgentSession(new NextRequest("http://localhost", { headers: { authorization: "Bearer token" } }), { requiredScopes: [] }))
      .resolves.toEqual({ ok: false, error: { code: "session_unavailable" } });
  });

  it("projects only the internal actor needed by services and derives recent authentication from the signed session", async () => {
    const { runtime, tokens } = fixture();
    const request = new NextRequest("http://localhost", { headers: { authorization: "Bearer token" } });
    const result = await runtime.authenticateAgentSession(request, { requiredScopes: ["chat:read"] });

    expect(tokens.verify).toHaveBeenCalledWith("token", expect.objectContaining({ requiredScopes: ["chat:read"], now: NOW }));
    expect(result).toEqual({
      ok: true,
      actor: { id: ACTOR.entrantId, github_id: 101, github_login: "alice", authenticated_at: NOW.toISOString(), session_id: ACTOR.sessionId },
    });
  });

  it("joins only an already-active member without reactivating membership, then adapts read and post boundaries", async () => {
    const { runtime, storage, memberships, chat } = fixture();
    await expect(runtime.getLiveCompetition("live-cup")).resolves.toEqual({ id: "live-cup", status: "live" });
    storage.getCompetition.mockResolvedValueOnce({ id: "closed-cup", status: "closed" });
    await expect(runtime.getLiveCompetition("closed-cup")).resolves.toBeNull();

    const actor = { id: ACTOR.entrantId, github_id: 101, github_login: "alice", authenticated_at: NOW.toISOString(), session_id: ACTOR.sessionId };
    await expect(runtime.joinCompetitionChat({ actor, competition_id: "live-cup" })).resolves.toEqual({
      ok: true,
      membership: { competition_id: "live-cup", state: "active", joined_at: NOW.toISOString() },
    });
    expect(chat.join).toHaveBeenCalledWith({ actor: { id: ACTOR.entrantId, github_id: 101, github_login: "alice" }, competition_id: "live-cup" });
    expect(memberships.set).not.toHaveBeenCalled();

    await runtime.readCompetitionChat({ actor, competition_id: "live-cup", cursor: "cursor", limit: 25, wait_seconds: 7 });
    expect(chat.list).toHaveBeenCalledWith({ actor: { id: ACTOR.entrantId, github_id: 101, github_login: "alice" }, competition_id: "live-cup", cursor: "cursor", limit: 25 });
    await runtime.postCompetitionMessage({ actor, competition_id: "live-cup", body: "hello", reply_to_id: "parent", idempotency_key: "op-1" });
    expect(chat.post).toHaveBeenCalledWith({ actor: { id: ACTOR.entrantId, github_id: 101, github_login: "alice" }, competition_id: "live-cup", body: "hello", reply_to_id: "parent", operation_id: "op-1" });
  });

  it("lists and revokes only sessions owned by the signed actor, with stable unavailable and not-found boundaries", async () => {
    const { runtime, sessions } = fixture();
    const actor = { id: ACTOR.entrantId, github_id: 101, github_login: "alice", authenticated_at: NOW.toISOString(), session_id: ACTOR.sessionId };
    (sessions as any).list = vi.fn().mockResolvedValue([
      { jti: ACTOR.sessionId, authenticatedAt: NOW.toISOString(), expiresAt: EXPIRES_AT, lastUsedAt: null },
      { jti: "00000000-0000-0000-0000-000000000502", authenticatedAt: NOW.toISOString(), expiresAt: EXPIRES_AT, lastUsedAt: NOW.toISOString() },
    ]);
    (sessions as any).revokeForEntrant = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await expect(runtime.listAgentSessions({ actor })).resolves.toEqual({
      sessions: [
        { session_id: ACTOR.sessionId, authenticated_at: NOW.toISOString(), expires_at: EXPIRES_AT, last_active_at: null, current: true },
        { session_id: "00000000-0000-0000-0000-000000000502", authenticated_at: NOW.toISOString(), expires_at: EXPIRES_AT, last_active_at: NOW.toISOString(), current: false },
      ],
    });
    await expect(runtime.revokeAgentSession({ actor, session_id: "00000000-0000-0000-0000-000000000502" }))
      .resolves.toEqual({ ok: true, revoked: true });
    await expect(runtime.revokeAgentSession({ actor, session_id: "00000000-0000-0000-0000-000000000503" }))
      .resolves.toEqual({ ok: false, error: { code: "not_found" } });
    await expect(runtime.revokeCurrentAgentSession({ actor })).resolves.toEqual({ revoked: true });
    expect((sessions as any).revokeForEntrant.mock.calls).toEqual([
      [{ jti: "00000000-0000-0000-0000-000000000502", entrantId: ACTOR.entrantId }],
      [{ jti: "00000000-0000-0000-0000-000000000503", entrantId: ACTOR.entrantId }],
      [{ jti: ACTOR.sessionId, entrantId: ACTOR.entrantId }],
    ]);

    const unavailable = fixture();
    await expect(unavailable.runtime.listAgentSessions({ actor })).rejects.toThrow("agent session repository is unavailable");
    await expect(unavailable.runtime.revokeCurrentAgentSession({ actor })).rejects.toThrow("agent session repository is unavailable");
    await expect(unavailable.runtime.revokeAgentSession({ actor, session_id: "missing" })).rejects.toThrow("agent session repository is unavailable");
  });

  it("keeps chat join fail-closed when its optional repository is absent or rejects the caller", async () => {
    const { runtime, chat } = fixture();
    const actor = { id: ACTOR.entrantId, github_id: 101, github_login: "alice", authenticated_at: NOW.toISOString(), session_id: ACTOR.sessionId };

    chat.join.mockResolvedValueOnce({ ok: false, error: { code: "forbidden" } }).mockResolvedValueOnce({ ok: false, error: { code: "conflict" } });
    await expect(runtime.joinCompetitionChat({ actor, competition_id: "live-cup" })).resolves.toEqual({ ok: false, error: { code: "forbidden" } });
    await expect(runtime.joinCompetitionChat({ actor, competition_id: "live-cup" })).resolves.toEqual({ ok: false, error: { code: "unavailable" } });

    const absent = fixture();
    delete (absent.chat as { join?: unknown }).join;
    await expect(absent.runtime.joinCompetitionChat({ actor, competition_id: "live-cup" })).resolves.toEqual({ ok: false, error: { code: "unavailable" } });
  });
});
