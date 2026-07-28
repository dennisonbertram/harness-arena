import { describe, expect, it, vi } from "vitest";

vi.stubEnv("AUTH_SECRET", "agent-token-test-secret");

import { mintAgentToken, verifyAgentToken } from "./agent-token";

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
});
