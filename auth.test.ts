import { describe, expect, it } from "vitest";
import { jwtCallback, sessionCallback } from "./lib/auth-callbacks";
import type { JWT } from "next-auth/jwt";
import type { Session } from "next-auth";

describe("jwtCallback", () => {
  it("copies numeric id and login from the GitHub profile into the token on initial sign-in", () => {
    const token = {} as JWT;
    const result = jwtCallback({
      token,
      profile: { id: 12345, login: "octocat" },
    });
    expect(result.githubId).toBe(12345);
    expect(result.githubLogin).toBe("octocat");
  });

  it("leaves existing claims intact when profile is absent (token refresh, not initial sign-in)", () => {
    const token = { githubId: 12345, githubLogin: "octocat" } as JWT;
    const result = jwtCallback({ token, profile: undefined });
    expect(result.githubId).toBe(12345);
    expect(result.githubLogin).toBe("octocat");
  });
});

describe("sessionCallback", () => {
  it("exposes githubId/githubLogin from the token onto session.user", () => {
    const session = { user: {}, expires: "2099-01-01T00:00:00.000Z" } as Session;
    const token = { githubId: 12345, githubLogin: "octocat" } as JWT;
    const result = sessionCallback({ session, token });
    expect(result.user.githubId).toBe(12345);
    expect(result.user.githubLogin).toBe("octocat");
  });

  it("leaves session.user identity fields unset when the token has no GitHub claims", () => {
    const session = { user: {}, expires: "2099-01-01T00:00:00.000Z" } as Session;
    const token = {} as JWT;
    const result = sessionCallback({ session, token });
    expect(result.user.githubId).toBeUndefined();
    expect(result.user.githubLogin).toBeUndefined();
  });
});
