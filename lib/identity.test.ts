import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
import { auth } from "@/auth";
import { mintAgentToken } from "./agent-token";
import { resolveIdentity } from "./identity";
import { asMockAuth } from "./test-support/auth-mock";

const mockAuth = asMockAuth(auth);

describe("resolveIdentity", () => {
  beforeEach(() => vi.stubEnv("AUTH_SECRET", "identity-test-secret"));
  afterEach(() => vi.unstubAllEnvs());

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

  it("uses the seeded identity only in explicit non-Vercel deterministic local development", async () => {
    mockAuth.mockResolvedValue(null);
    vi.stubEnv("HARNESS_DEVELOPMENT_IDENTITY", "seeded");
    vi.stubEnv("HARNESS_EXECUTION_MODE", "deterministic-success");
    vi.stubEnv("HARNESS_LOCAL_INIT", "1");
    vi.stubEnv("HARNESS_GIT_BRANCH", "codex/deterministic-local-sandbox");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STORAGE", "file");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("VERCEL_PROJECT_ID", "");

    await expect(resolveIdentity(new NextRequest("http://127.0.0.1:3000/api/submissions"))).resolves.toEqual({
      githubId: -144,
      githubLogin: "harness-local-development",
    });
  });

  it.each([
    ["main branch", { HARNESS_GIT_BRANCH: "main" }],
    ["Vercel runtime", { VERCEL: "1", VERCEL_ENV: "development" }],
    ["non-file storage", { STORAGE: "blob" }],
  ])("fails the seeded local identity closed in %s", async (_label, override) => {
    mockAuth.mockResolvedValue(null);
    const base = {
      HARNESS_DEVELOPMENT_IDENTITY: "seeded",
      HARNESS_EXECUTION_MODE: "deterministic-success",
      HARNESS_LOCAL_INIT: "1",
      HARNESS_GIT_BRANCH: "codex/deterministic-local-sandbox",
      NODE_ENV: "development",
      STORAGE: "file",
      VERCEL: "",
      VERCEL_ENV: "",
      VERCEL_PROJECT_ID: "",
      ...override,
    };
    for (const [key, value] of Object.entries(base)) vi.stubEnv(key, value);

    await expect(resolveIdentity(new NextRequest("http://127.0.0.1:3000/api/submissions"))).resolves.toBeNull();
  });
});
