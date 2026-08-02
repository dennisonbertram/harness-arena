import { describe, expect, it, vi } from "vitest";

import { runDevelopmentVercelOperation } from "./vercel-development.mjs";

const DEVELOPMENT_PROJECT_ID = "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA";
const LIVE_PROJECT_ID = "prj_f4ppu0xpO0LZeHOAH99RHotVbwyo";

function manifest(overrides = {}) {
  return {
    environment: "development",
    branch: "dev",
    vercelProject: { id: DEVELOPMENT_PROJECT_ID, name: "harness-arena-development" },
    host: "harness-arena-development.vercel.app",
    store: { id: "store_development" },
    callbackOrigin: "https://harness-arena-development.vercel.app",
    live: {
      projectId: LIVE_PROJECT_ID,
      aliases: [
        "harness-arena-psi.vercel.app",
        "harness-arena-dennisons-projects.vercel.app",
        "harness-arena-git-main-dennisons-projects.vercel.app",
      ],
      storeIds: ["store_SgaF1fm7nkPQPCKq"],
    },
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  return {
    cwd: "/repo",
    readManifest: async () => manifest(),
    readLinkedProject: async () => ({ projectId: DEVELOPMENT_PROJECT_ID }),
    gitState: async () => ({ branch: "dev", isClean: true }),
    spawn: vi.fn(async () => ({ stdout: "deployment-url\n", stderr: "", code: 0 })),
    ...overrides,
  };
}

async function expectRejectedWithoutSpawn(deps, operation = "deploy") {
  await expect(runDevelopmentVercelOperation({ operation, ...deps })).rejects.toThrow(
    /development Vercel operation denied/i,
  );
  expect(deps.spawn).not.toHaveBeenCalled();
}

describe("Development-only Vercel mutation wrapper", () => {
  it("executes the one exact development deploy argv with no shell", async () => {
    const deps = dependencies();

    await expect(runDevelopmentVercelOperation({ operation: "deploy", ...deps })).resolves.toEqual({
      stdout: "deployment-url\n",
      stderr: "",
    });

    expect(deps.spawn).toHaveBeenCalledWith("vercel", ["deploy", "--yes", "--target", "development"], {
      cwd: "/repo",
      shell: false,
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
    });
  });

  it.each([
    "promote",
    "rollback",
    "alias",
    "domain",
    "env",
    "store",
    "deploy --prod",
    "deploy --target production",
    "deploy; vercel --prod",
  ])("rejects an unapproved or option-injected operation before spawn: %s", async (operation) => {
    const deps = dependencies();
    await expectRejectedWithoutSpawn(deps, operation);
  });

  it.each([
    ["the live project", manifest({ vercelProject: { id: LIVE_PROJECT_ID, name: "live" } })],
    [
      "a live alias",
      manifest({
        host: "harness-arena-psi.vercel.app",
        callbackOrigin: "https://harness-arena-psi.vercel.app",
      }),
    ],
    ["a live Blob store", manifest({ store: { id: "store_SgaF1fm7nkPQPCKq" } })],
    ["an unknown manifest key", manifest({ unsafeOption: "--prod" })],
    ["a missing callback", manifest({ callbackOrigin: null })],
    ["a non-pinned development project", manifest({ vercelProject: { id: "prj_other", name: "other" } })],
  ])("rejects %s manifest state before spawn", async (_name, invalidManifest) => {
    const deps = dependencies({ readManifest: async () => invalidManifest });
    await expectRejectedWithoutSpawn(deps);
  });

  it.each([
    ["a linked live project", { projectId: LIVE_PROJECT_ID }],
    ["a mismatched linked project", { projectId: "prj_other" }],
    ["missing linked project metadata", null],
    ["malformed linked project metadata", { projectId: 42 }],
  ])("rejects %s before spawn", async (_name, linkedProject) => {
    const deps = dependencies({ readLinkedProject: async () => linkedProject });
    await expectRejectedWithoutSpawn(deps);
  });

  it.each([
    ["main", { branch: "main", isClean: true }],
    ["a non-development branch", { branch: "feature/unsafe", isClean: true }],
    ["a dirty tree", { branch: "dev", isClean: false }],
    ["unknown git state", null],
  ])("rejects %s before spawn", async (_name, gitState) => {
    const deps = dependencies({ gitState: async () => gitState });
    await expectRejectedWithoutSpawn(deps);
  });

  it("allows a clean codex development branch but never leaks child output in errors", async () => {
    const deps = dependencies({
      gitState: async () => ({ branch: "codex/vercel-development-guard", isClean: true }),
      spawn: vi.fn(async () => ({ stdout: "secret-token-value", stderr: "secret-token-value", code: 1 })),
    });

    await expect(runDevelopmentVercelOperation({ operation: "deploy", ...deps })).rejects.toThrow(
      "development Vercel operation failed (exit 1)",
    );
    await expect(runDevelopmentVercelOperation({ operation: "deploy", ...deps })).rejects.not.toThrow(
      /secret-token-value/,
    );
  });
});
