import { SignJWT } from "jose";
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

async function signedSession(overrides: Record<string, unknown> = {}, options: { jti?: string | null; lifetime?: number; setIssuedAt?: boolean; setExpiration?: boolean } = {}) {
  const issuedAt = Math.floor(Date.now() / 1000);
  let token = new SignJWT({
    entrantId: identity.entrantId,
    githubId: identity.githubId,
    githubLogin: identity.githubLogin,
    tokenVersion: 1,
    scopes: ["competitions:read"],
    authenticatedAt: new Date(issuedAt * 1000).toISOString(),
    ...overrides,
  })
    .setProtectedHeader({ alg: "HS256", kid: "agent-key-1" })
    .setIssuer("https://harness-arena.example")
    .setAudience("harness-arena-mcp");
  if (options.jti !== null) token = token.setJti(options.jti ?? session.jti);
  if (options.setIssuedAt !== false) token = token.setIssuedAt(issuedAt);
  if (options.setExpiration !== false) token = token.setExpirationTime(issuedAt + (options.lifetime ?? 600));
  return token.sign(new TextEncoder().encode("scoped-agent-session-test-secret"));
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

  it("rejects every malformed mint boundary before signing", async () => {
    for (const value of [0, -1, 1.5]) {
      await expect(mintAgentSessionToken(identity, { ...session, expiresInSeconds: value }))
        .rejects.toMatchObject({ code: "malformed" });
    }
    for (const invalid of [
      { tokenVersion: 0 },
      { tokenVersion: 1.5 },
      { scopes: [] },
      { scopes: [""] },
      { scopes: ["chat:read", 1] },
    ]) {
      await expect(mintAgentSessionToken(identity, { ...session, ...invalid } as never))
        .rejects.toMatchObject({ code: "malformed" });
    }
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

    const touchFailure = sessions();
    touchFailure.touch.mockRejectedValueOnce(new Error("database unavailable at postgres://secret"));
    await expect(verifyAgentSessionToken(token, { sessions: touchFailure, requiredScopes: [] }))
      .rejects.toMatchObject({ code: "session_unavailable", message: "session_unavailable" });
  });

  it("rejects malformed compact tokens and every required scoped-session claim", async () => {
    await expect(verifyAgentSessionToken("x.y.z", { sessions: sessions(), requiredScopes: [] }))
      .rejects.toMatchObject({ code: "malformed" });

    const invalidClaims: Array<[Record<string, unknown>, { jti?: string | null; lifetime?: number; setIssuedAt?: boolean; setExpiration?: boolean }?]> = [
      [{ entrantId: 1 }],
      [{ githubId: "101" }],
      [{ githubLogin: 101 }],
      [{ tokenVersion: "1" }],
      [{ tokenVersion: 1.5 }],
      [{ tokenVersion: 0 }],
      [{ scopes: "competitions:read" }],
      [{ scopes: [] }],
      [{ scopes: [1] }],
      [{ scopes: [""] }],
      [{ authenticatedAt: 1 }],
      [{ iat: "now" }, { setIssuedAt: false }],
      [{ exp: "later" }, { setExpiration: false }],
      [{}, { jti: null }],
      [{}, { lifetime: 30 * 24 * 60 * 60 + 1 }],
    ];
    for (const [claims, options] of invalidClaims) {
      const token = await signedSession(claims, options);
      await expect(verifyAgentSessionToken(token, { sessions: sessions(), requiredScopes: [] }))
        .rejects.toMatchObject({ code: "malformed" });
    }
  });

  it("fails before cryptography when server token configuration or signing secret is missing", async () => {
    vi.stubEnv("AGENT_TOKEN_ISSUER", "");
    await expect(mintAgentSessionToken(identity, session)).rejects.toThrow("agent session token configuration is incomplete");
    vi.stubEnv("AGENT_TOKEN_ISSUER", "https://harness-arena.example");

    vi.stubEnv("AUTH_SECRET", "");
    await expect(mintAgentSessionToken(identity, session)).rejects.toThrow("AUTH_SECRET is not configured on the server");
    vi.stubEnv("AUTH_SECRET", "scoped-agent-session-test-secret");
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
