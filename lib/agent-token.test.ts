import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

vi.stubEnv("AUTH_SECRET", "agent-token-test-secret");

import {
  AGENT_TOKEN_AUDIENCE,
  AGENT_TOKEN_ISSUER,
  AGENT_TOKEN_VERSION,
  mintAgentToken,
  verifyAgentToken,
} from "./agent-token";

const secret = new TextEncoder().encode("agent-token-test-secret");

async function signRawToken(claims: Record<string, unknown>): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600);
  return jwt.sign(secret);
}

describe("agent tokens", () => {
  it("mints an HS256 agent token that verifies its identity and 90-day expiry", async () => {
    const token = await mintAgentToken({ githubId: 42, githubLogin: "octocat" });
    const identity = await verifyAgentToken(token);

    expect(identity).toEqual({ githubId: 42, githubLogin: "octocat" });
    const [, payload] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toMatchObject({ githubId: 42, githubLogin: "octocat", scope: "agent" });
    expect(claims.exp - claims.iat).toBe(90 * 24 * 60 * 60);
  });

  it("rejects an expired token", async () => {
    const token = await mintAgentToken({ githubId: 42, githubLogin: "octocat" }, { expiresInSeconds: -1 });
    await expect(verifyAgentToken(token)).rejects.toMatchObject({ code: "expired" });
  });

  it("rejects a token with a bad signature", async () => {
    const token = await mintAgentToken({ githubId: 42, githubLogin: "octocat" });
    await expect(verifyAgentToken(`${token}x`)).rejects.toMatchObject({ code: "bad_signature" });
  });

  it("rejects a token without the agent scope", async () => {
    const token = await mintAgentToken({ githubId: 42, githubLogin: "octocat" }, { scope: "other" });
    await expect(verifyAgentToken(token)).rejects.toMatchObject({ code: "invalid_scope" });
  });

  it("rejects malformed tokens", async () => {
    await expect(verifyAgentToken("not-a-jwt")).rejects.toMatchObject({ code: "malformed" });
  });

  it("rejects a token signed without iss and aud claims", async () => {
    const token = await signRawToken({ githubId: 42, githubLogin: "octocat", scope: "agent" });
    await expect(verifyAgentToken(token)).rejects.toMatchObject({ code: "malformed" });
  });

  it("rejects a token with a mismatched aud claim", async () => {
    const token = await signRawToken({
      githubId: 42,
      githubLogin: "octocat",
      scope: "agent",
      iss: AGENT_TOKEN_ISSUER,
      aud: "some-other-audience",
      ver: AGENT_TOKEN_VERSION,
    });
    await expect(verifyAgentToken(token)).rejects.toMatchObject({ code: "malformed" });
  });

  it("rejects a token with a mismatched iss claim", async () => {
    const token = await signRawToken({
      githubId: 42,
      githubLogin: "octocat",
      scope: "agent",
      iss: "some-other-issuer",
      aud: AGENT_TOKEN_AUDIENCE,
      ver: AGENT_TOKEN_VERSION,
    });
    await expect(verifyAgentToken(token)).rejects.toMatchObject({ code: "malformed" });
  });

  it("rejects a token with a stale version claim", async () => {
    const token = await signRawToken({
      githubId: 42,
      githubLogin: "octocat",
      scope: "agent",
      iss: AGENT_TOKEN_ISSUER,
      aud: AGENT_TOKEN_AUDIENCE,
      ver: AGENT_TOKEN_VERSION + 1,
    });
    await expect(verifyAgentToken(token)).rejects.toMatchObject({ code: "malformed" });
  });

  it("rejects a token missing the version claim", async () => {
    const token = await signRawToken({
      githubId: 42,
      githubLogin: "octocat",
      scope: "agent",
      iss: AGENT_TOKEN_ISSUER,
      aud: AGENT_TOKEN_AUDIENCE,
    });
    await expect(verifyAgentToken(token)).rejects.toMatchObject({ code: "malformed" });
  });

  it("mints tokens carrying the expected issuer, audience, and version claims", async () => {
    const token = await mintAgentToken({ githubId: 42, githubLogin: "octocat" });
    const [, payload] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toMatchObject({
      iss: AGENT_TOKEN_ISSUER,
      aud: AGENT_TOKEN_AUDIENCE,
      ver: AGENT_TOKEN_VERSION,
    });
  });
});
