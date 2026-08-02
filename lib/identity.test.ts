import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.stubEnv("AUTH_SECRET", "identity-test-secret");

import { auth } from "@/auth";
import { mintAgentToken } from "./agent-token";
import { resolveIdentity } from "./identity";
import { asMockAuth } from "./test-support/auth-mock";

const mockAuth = asMockAuth(auth);

describe("resolveIdentity", () => {
  it("prefers the Auth.js session when one is present", async () => {
    mockAuth.mockResolvedValue({ user: { githubId: 7, githubLogin: "session-user" } } as never);
    const token = await mintAgentToken({ githubId: 8, githubLogin: "bearer-user" });

    await expect(
      resolveIdentity(new NextRequest("http://localhost", { headers: { authorization: `Bearer ${token}` } })),
    ).resolves.toEqual({ githubId: 7, githubLogin: "session-user" });
  });

  it("uses a valid bearer token when no session exists", async () => {
    mockAuth.mockResolvedValue(null);
    const token = await mintAgentToken({ githubId: 8, githubLogin: "bearer-user" });

    await expect(
      resolveIdentity(new NextRequest("http://localhost", { headers: { authorization: `Bearer ${token}` } })),
    ).resolves.toEqual({ githubId: 8, githubLogin: "bearer-user" });
  });
});
