import { describe, expect, it, vi } from "vitest";

vi.stubEnv("AUTH_SECRET", "scoped-agent-session-test-secret");
vi.stubEnv("AGENT_TOKEN_ISSUER", "https://harness-arena.example");
vi.stubEnv("AGENT_TOKEN_AUDIENCE", "harness-arena-mcp");
vi.stubEnv("AGENT_TOKEN_KEY_ID", "agent-key-1");

import { mintAgentSessionToken, mintAgentToken, verifyAgentSessionToken } from "./agent-token";

const identity = {
  entrantId: "00000000-0000-0000-0000-000000000101",
  githubId: 101,
  githubLogin: "octocat",
};
const session = {
  jti: "00000000-0000-0000-0000-000000000901",
  tokenVersion: 1,
  scopes: ["competitions:read", "competitions:write", "chat:read", "chat:write"],
  authenticatedAt: "2026-08-02T12:00:00.000Z",
  expiresInSeconds: 30 * 24 * 60 * 60,
};

function sessions(authenticated = true) {
  return { isAuthenticated: vi.fn().mockResolvedValue(authenticated), touch: vi.fn().mockResolvedValue(undefined) };
}

describe("revocable scoped agent session tokens", () => {
  it("mints bounded iss/aud/kid/jti/version/scopes claims without storing or exposing credentials", async () => {
    const token = await mintAgentSessionToken(identity, session);
    const [header, payload] = token.split(".");
    const decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString());
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());

    expect(decodedHeader).toMatchObject({ alg: "HS256", kid: "agent-key-1" });
    expect(decoded).toMatchObject({
      jti: session.jti,
      iss: "https://harness-arena.example",
      aud: "harness-arena-mcp",
      entrantId: identity.entrantId,
      githubId: identity.githubId,
      githubLogin: identity.githubLogin,
      tokenVersion: 1,
      scopes: session.scopes,
      authenticatedAt: session.authenticatedAt,
    });
    expect(decoded.exp - decoded.iat).toBe(session.expiresInSeconds);
    expect(JSON.stringify(decoded)).not.toMatch(/access.?token|refresh.?token|device.?code|github.?token/i);
  });

  it("rejects sessions longer than 30 days and malformed authentication timestamps", async () => {
    await expect(mintAgentSessionToken(identity, { ...session, expiresInSeconds: 30 * 24 * 60 * 60 + 1 }))
      .rejects.toMatchObject({ code: "malformed" });
    await expect(mintAgentSessionToken(identity, { ...session, authenticatedAt: "not-a-date" }))
      .rejects.toMatchObject({ code: "malformed" });
  });

  it("checks durable session state, exact token metadata, and required scopes before returning identity", async () => {
    const store = sessions();
    const token = await mintAgentSessionToken(identity, session);
    await expect(verifyAgentSessionToken(token, {
      sessions: store,
      requiredScopes: ["competitions:read", "chat:write"],
      now: new Date("2026-08-02T12:05:00.000Z"),
    })).resolves.toEqual({ ...identity, sessionId: session.jti, scopes: session.scopes, authenticatedAt: session.authenticatedAt });
    expect(store.isAuthenticated).toHaveBeenCalledWith({
      jti: session.jti,
      issuer: "https://harness-arena.example",
      audience: "harness-arena-mcp",
      keyId: "agent-key-1",
      tokenVersion: 1,
      now: new Date("2026-08-02T12:05:00.000Z"),
    });
    expect(store.touch).toHaveBeenCalledWith(session.jti);
  });

  it.each([
    [false, "revoked"],
  ] as const)("fails closed when durable authentication is %s", async (authenticated, code) => {
    const token = await mintAgentSessionToken(identity, session);
    await expect(verifyAgentSessionToken(token, { sessions: sessions(authenticated), requiredScopes: [] }))
      .rejects.toMatchObject({ code });
  });

  it("fails closed on session-store outage and never falls back to signature-only acceptance", async () => {
    const token = await mintAgentSessionToken(identity, session);
    const store = sessions();
    store.isAuthenticated.mockRejectedValueOnce(new Error("database unavailable at postgres://secret"));
    await expect(verifyAgentSessionToken(token, { sessions: store, requiredScopes: [] }))
      .rejects.toMatchObject({ code: "session_unavailable", message: "session_unavailable" });
  });

  it("rejects legacy, wrong-scope, wrong-audience, wrong-key, and wrong-version tokens on the scoped path", async () => {
    const store = sessions();
    const legacy = await mintAgentToken({ githubId: identity.githubId, githubLogin: identity.githubLogin });
    await expect(verifyAgentSessionToken(legacy, { sessions: store, requiredScopes: [] })).rejects.toMatchObject({ code: "legacy_token" });

    const token = await mintAgentSessionToken(identity, session);
    await expect(verifyAgentSessionToken(token, { sessions: store, requiredScopes: ["payouts:write"] })).rejects.toMatchObject({ code: "insufficient_scope" });

    vi.stubEnv("AGENT_TOKEN_AUDIENCE", "wrong-audience");
    await expect(verifyAgentSessionToken(token, { sessions: store, requiredScopes: [] })).rejects.toMatchObject({ code: "malformed" });
    vi.stubEnv("AGENT_TOKEN_AUDIENCE", "harness-arena-mcp");

    vi.stubEnv("AGENT_TOKEN_KEY_ID", "agent-key-2");
    await expect(verifyAgentSessionToken(token, { sessions: store, requiredScopes: [] })).rejects.toMatchObject({ code: "wrong_key" });
    vi.stubEnv("AGENT_TOKEN_KEY_ID", "agent-key-1");

    const wrongVersion = await mintAgentSessionToken(identity, { ...session, tokenVersion: 2 });
    store.isAuthenticated.mockResolvedValueOnce(false);
    await expect(verifyAgentSessionToken(wrongVersion, { sessions: store, requiredScopes: [] })).rejects.toMatchObject({ code: "revoked" });
  });
});
