import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
import { auth } from "@/auth";
import { mintAgentToken } from "./agent-token";
import { resolveSeededDevelopmentIdentity } from "./development-identity";
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

describe("hosted seeded Development identity", () => {
  const manifest = {
    environment: "development",
    branch: "dev",
    git: { provider: "github", repository: "dennisonbertram/harness-arena", productionBranch: "dev" },
    vercelProject: { id: "prj_development", name: "harness-arena-development" },
    host: "harness-arena-development.example.test",
    store: { id: "store_development" },
    callbackOrigin: "https://harness-arena-development.example.test",
    live: {
      projectId: "prj_live",
      aliases: ["harness-arena-live.example.test"],
      storeIds: ["store_live"],
    },
  };
  const valid = {
    HARNESS_DEVELOPMENT_IDENTITY: "seeded",
    VERCEL: "1",
    VERCEL_ENV: "production",
    VERCEL_PROJECT_ID: manifest.vercelProject.id,
    VERCEL_GIT_COMMIT_REF: manifest.branch,
    STORAGE: "blob",
    BLOB_READ_WRITE_TOKEN: "configured-without-inspection",
    HARNESS_BLOB_STORE_ID: manifest.store.id,
    CALLBACK_BASE: manifest.callbackOrigin,
  };

  it("accepts only the fully manifest-bound isolated Development identity", () => {
    expect(resolveSeededDevelopmentIdentity(
      new NextRequest(`${manifest.callbackOrigin}/api/submissions`),
      valid,
      manifest as never,
    )).toEqual({ githubId: -144, githubLogin: "harness-local-development" });
  });

  it.each([
    ["missing project", { VERCEL_PROJECT_ID: "" }, manifest.callbackOrigin],
    ["unknown project", { VERCEL_PROJECT_ID: "prj_unknown" }, manifest.callbackOrigin],
    ["live project", { VERCEL_PROJECT_ID: manifest.live.projectId }, manifest.callbackOrigin],
    ["main branch", { VERCEL_GIT_COMMIT_REF: "main" }, manifest.callbackOrigin],
    ["live store", { HARNESS_BLOB_STORE_ID: manifest.live.storeIds[0] }, manifest.callbackOrigin],
    ["live callback", { CALLBACK_BASE: `https://${manifest.live.aliases[0]}` }, manifest.callbackOrigin],
    ["live request alias", {}, `https://${manifest.live.aliases[0]}`],
  ])("rejects %s", (_label, override, requestOrigin) => {
    expect(resolveSeededDevelopmentIdentity(
      new NextRequest(`${requestOrigin}/api/submissions`),
      { ...valid, ...override },
      manifest as never,
    )).toBeNull();
  });
});
