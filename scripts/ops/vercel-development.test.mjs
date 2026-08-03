import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import * as subject from "./vercel-development.mjs";

const DEVELOPMENT_PROJECT_ID = "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA";
const LIVE_PROJECT_ID = "prj_f4ppu0xpO0LZeHOAH99RHotVbwyo";
const TEAM_ID = "team_cwyLpng8LCwWgINdiQ27hHYa";
const SCOPE = "dennisons-projects";
const REVIEWED_SHA = "a".repeat(40);
const LIVE_STORE_ID = "store_SgaF1fm7nkPQPCKq";
const TOKEN = "test-vercel-token-never-print";
const UPSTREAM_URL = "https://github.com/dennisonbertram/harness-arena.git";

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
      storeIds: [LIVE_STORE_ID],
    },
    ...overrides,
  };
}

function provenance(overrides = {}) {
  return {
    reviewedSha: REVIEWED_SHA,
    remote: {
      name: "origin",
      url: UPSTREAM_URL,
      ref: "refs/heads/dev",
      sha: REVIEWED_SHA,
    },
    isAncestor: true,
    ...overrides,
  };
}

function preflight(overrides = {}) {
  return {
    project: {
      id: DEVELOPMENT_PROJECT_ID,
      ownerId: TEAM_ID,
      name: "harness-arena-development",
    },
    environment: {
      callbackBase: "https://harness-arena-development.vercel.app",
    },
    store: {
      id: "store_development",
      ownerId: TEAM_ID,
      projectId: DEVELOPMENT_PROJECT_ID,
      type: "blob",
    },
    ...overrides,
  };
}

function deployment(overrides = {}) {
  return {
    id: "dpl_development_preview",
    url: "harness-arena-development-preview.vercel.app",
    projectId: DEVELOPMENT_PROJECT_ID,
    ownerId: TEAM_ID,
    target: null,
    meta: { reviewedSha: REVIEWED_SHA },
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  const cleanup = vi.fn(async () => {});
  return {
    cwd: "/repo",
    reviewedSha: REVIEWED_SHA,
    token: TOKEN,
    inheritedEnv: {
      PATH: "/attacker/bin",
      NODE_OPTIONS: "--require=/tmp/attacker.cjs",
      VERCEL_ORG_ID: "team_attacker",
      VERCEL_PROJECT_ID: LIVE_PROJECT_ID,
      VERCEL_TARGET_ENV: "production",
      VERCEL_FORCE_NO_BUILD_CACHE: "1",
      FORCE_COLOR: "1",
    },
    readManifest: async () => manifest(),
    readProvenance: async () => provenance(),
    createSnapshot: vi.fn(async () => ({ path: "/immutable/snapshot", cleanup })),
    readOnlyApi: {
      preflight: vi.fn(async () => preflight()),
      deployment: vi.fn(async () => deployment()),
    },
    spawn: vi.fn(async () => ({
      stdout: "https://harness-arena-development-preview.vercel.app\n",
      stderr: "",
      code: 0,
      timedOut: false,
      reaped: true,
    })),
    cleanup,
    ...overrides,
  };
}

async function expectDeniedWithoutSpawn(deps, operation = "deploy") {
  await expect(subject.runDevelopmentVercelOperation({ operation, ...deps })).rejects.toThrow(
    /development Vercel operation denied/i,
  );
  expect(deps.spawn).not.toHaveBeenCalled();
}

function tarBuffer(entries) {
  const blocks = [];
  for (const { name, type = "0", body = "" } of entries) {
    const content = Buffer.from(body);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(type, 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe("Development-only Vercel Preview deployment", () => {
  it("invokes only the pinned local CLI with an immutable snapshot and a scrubbed environment", async () => {
    const deps = dependencies();

    await expect(subject.runDevelopmentVercelOperation({ operation: "deploy", ...deps })).resolves.toEqual({
      deploymentId: "dpl_development_preview",
      reviewedSha: REVIEWED_SHA,
      url: "https://harness-arena-development-preview.vercel.app",
    });

    expect(deps.spawn).toHaveBeenCalledTimes(1);
    const [file, argv, options] = deps.spawn.mock.calls[0];
    expect(file).toBe(process.execPath);
    expect(path.isAbsolute(argv[0])).toBe(true);
    expect(argv[0]).toMatch(/node_modules\/vercel\/dist\/vc\.js$/);
    expect(argv).toEqual([
      argv[0],
      "deploy",
      "/immutable/snapshot",
      "--yes",
      "--no-wait",
      "--scope",
      SCOPE,
      "--meta",
      `reviewedSha=${REVIEWED_SHA}`,
    ]);
    expect(argv).not.toContain("--target");
    expect(options).toEqual({
      cwd: "/immutable/snapshot",
      env: {
        VERCEL_ORG_ID: TEAM_ID,
        VERCEL_PROJECT_ID: DEVELOPMENT_PROJECT_ID,
        VERCEL_TOKEN: TOKEN,
      },
      timeoutMs: 30_000,
      termGraceMs: 2_000,
      maxOutputBytes: 65_536,
    });
    expect(options.env).not.toHaveProperty("PATH");
    expect(options.env).not.toHaveProperty("NODE_OPTIONS");
    expect(options.env).not.toHaveProperty("VERCEL_TARGET_ENV");
    expect(deps.createSnapshot).toHaveBeenCalledWith({ cwd: "/repo", reviewedSha: REVIEWED_SHA });
    expect(deps.cleanup).toHaveBeenCalledTimes(1);
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
    await expectDeniedWithoutSpawn(deps, operation);
  });

  it.each([
    ["the live project", manifest({ vercelProject: { id: LIVE_PROJECT_ID, name: "live" } })],
    ["a live callback", manifest({ callbackOrigin: "https://harness-arena-psi.vercel.app" })],
    ["a live Blob store", manifest({ store: { id: LIVE_STORE_ID } })],
    ["an unknown manifest key", manifest({ unsafeOption: "--prod" })],
    ["a missing callback", manifest({ callbackOrigin: null })],
  ])("rejects %s manifest state before any upload", async (_name, invalidManifest) => {
    const deps = dependencies({ readManifest: async () => invalidManifest });
    await expectDeniedWithoutSpawn(deps);
    expect(deps.createSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["an unpinned SHA", "HEAD"],
    ["a spoofed upstream", REVIEWED_SHA, provenance({ remote: { ...provenance().remote, url: "https://evil.test/repo" } })],
    ["a spoofed ref", REVIEWED_SHA, provenance({ remote: { ...provenance().remote, ref: "refs/heads/main" } })],
    ["a different protected SHA", REVIEWED_SHA, provenance({ remote: { ...provenance().remote, sha: "b".repeat(40) } })],
    ["a non-ancestor", REVIEWED_SHA, provenance({ isAncestor: false })],
    ["unknown provenance fields", REVIEWED_SHA, provenance({ branch: "dev" })],
  ])("rejects %s rather than trusting branch name or cleanliness", async (_name, reviewedSha, state) => {
    const deps = dependencies({ reviewedSha, readProvenance: async () => state ?? provenance() });
    await expectDeniedWithoutSpawn(deps);
    expect(deps.createSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["live project", preflight({ project: { ...preflight().project, id: LIVE_PROJECT_ID } })],
    ["wrong owner", preflight({ project: { ...preflight().project, ownerId: "team_other" } })],
    ["unknown project metadata", preflight({ project: { ...preflight().project, production: true } })],
    ["missing callback", preflight({ environment: {} })],
    ["live callback", preflight({ environment: { callbackBase: "https://harness-arena-psi.vercel.app" } })],
    ["unknown environment metadata", preflight({ environment: { callbackBase: manifest().callbackOrigin, OTHER: "x" } })],
    ["live store", preflight({ store: { ...preflight().store, id: LIVE_STORE_ID } })],
    ["store on live project", preflight({ store: { ...preflight().store, projectId: LIVE_PROJECT_ID } })],
    ["wrong store owner", preflight({ store: { ...preflight().store, ownerId: "team_other" } })],
    ["wrong store type", preflight({ store: { ...preflight().store, type: "postgres" } })],
    ["unknown top-level metadata", preflight({ production: true })],
  ])("fails closed on mismatched actual preflight metadata: %s", async (_name, actual) => {
    const deps = dependencies({
      readOnlyApi: {
        preflight: vi.fn(async () => actual),
        deployment: vi.fn(async () => deployment()),
      },
    });
    await expectDeniedWithoutSpawn(deps);
    expect(deps.createSnapshot).not.toHaveBeenCalled();
  });

  it("uploads neither mutable nor ignored cwd files and always removes the temporary snapshot", async () => {
    const deps = dependencies({ cwd: "/mutable/repo-with-ignored-secrets" });
    deps.spawn.mockRejectedValueOnce(new Error(`failure ${TOKEN}`));

    await expect(subject.runDevelopmentVercelOperation({ operation: "deploy", ...deps })).rejects.toThrow(
      "Development Vercel operation failed",
    );
    expect(deps.spawn.mock.calls[0][1]).not.toContain("/mutable/repo-with-ignored-secrets");
    expect(deps.spawn.mock.calls[0][2].cwd).toBe("/immutable/snapshot");
    expect(deps.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["CLI failure", { stdout: TOKEN, stderr: TOKEN, code: 1, timedOut: false, reaped: true }],
    ["CLI timeout", { stdout: TOKEN, stderr: TOKEN, code: 1, timedOut: true, reaped: true }],
    ["unreaped process tree", { stdout: "", stderr: "", code: 1, timedOut: true, reaped: false }],
    ["malformed output", { stdout: "not a deployment", stderr: "", code: 0, timedOut: false, reaped: true }],
    ["ambiguous output", { stdout: "https://one.vercel.app\nhttps://two.vercel.app\n", stderr: "", code: 0, timedOut: false, reaped: true }],
  ])("rejects secret-safe %s and cleans the snapshot", async (_name, result) => {
    const deps = dependencies({ spawn: vi.fn(async () => result) });
    const error = await subject.runDevelopmentVercelOperation({ operation: "deploy", ...deps }).catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(TOKEN);
    expect(deps.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["live project", deployment({ projectId: LIVE_PROJECT_ID })],
    ["wrong owner", deployment({ ownerId: "team_other" })],
    ["production target", deployment({ target: "production" })],
    ["development target", deployment({ target: "development" })],
    ["different SHA", deployment({ meta: { reviewedSha: "b".repeat(40) } })],
    ["different URL", deployment({ url: "different.vercel.app" })],
    ["unknown key", deployment({ production: true })],
    ["malformed response", null],
  ])("rejects postflight deployment mismatch: %s", async (_name, actual) => {
    const deps = dependencies({
      readOnlyApi: {
        preflight: vi.fn(async () => preflight()),
        deployment: vi.fn(async () => actual),
      },
    });
    await expect(subject.runDevelopmentVercelOperation({ operation: "deploy", ...deps })).rejects.toThrow(
      /postflight denied/i,
    );
    expect(deps.cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not expose a token when read-only APIs fail with secret-bearing errors", async () => {
    const deps = dependencies({
      readOnlyApi: {
        preflight: vi.fn(async () => { throw new Error(`remote said ${TOKEN}`); }),
        deployment: vi.fn(),
      },
    });
    const error = await subject.runDevelopmentVercelOperation({ operation: "deploy", ...deps }).catch((value) => value);
    expect(error.message).toBe("Development Vercel operation denied by local safety policy");
    expect(error.message).not.toContain(TOKEN);
  });
});

describe("reviewed Git archive snapshots", () => {
  it.each([
    ["parent traversal", "../escape", "0"],
    ["nested traversal", "safe/../../escape", "0"],
    ["absolute path", "/escape", "0"],
    ["backslash traversal", "..\\escape", "0"],
    ["symlink", "link", "2"],
    ["hard link", "link", "1"],
    ["character device", "device", "3"],
    ["block device", "device", "4"],
    ["fifo", "fifo", "6"],
    ["extended metadata", "meta", "x"],
  ])("rejects an archive containing %s", (_name, name, type) => {
    expect(() => subject.validateTarArchive(tarBuffer([{ name, type }]))).toThrow(/archive denied/i);
  });

  it("accepts only regular files/directories with canonical relative paths", () => {
    expect(subject.validateTarArchive(tarBuffer([
      { name: "app/", type: "5" },
      { name: "app/page.tsx", body: "export default 1" },
    ]))).toEqual(["app/", "app/page.tsx"]);
  });

  it("archives the exact reviewed object, validates before extraction, and cleans temporary state", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "issue175-test-"));
    const events = [];
    const archive = tarBuffer([{ name: "tracked.txt", body: "reviewed" }]);
    try {
      const snapshot = await subject.createReviewedSnapshot({
        cwd: "/mutable/repo",
        reviewedSha: REVIEWED_SHA,
        makeTempDirectory: async () => temp,
        archiveToFile: async ({ cwd, reviewedSha, archivePath }) => {
          events.push(["archive", cwd, reviewedSha]);
          await writeFile(archivePath, archive);
        },
        extractArchive: async ({ archivePath, destination }) => {
          events.push(["extract", archivePath, destination]);
        },
        removeTemp: async (target) => {
          events.push(["remove", target]);
          await rm(target, { recursive: true, force: true });
        },
      });
      expect(snapshot.path).toBe(path.join(temp, "snapshot"));
      expect(events[0]).toEqual(["archive", "/mutable/repo", REVIEWED_SHA]);
      expect(events[1][0]).toBe("extract");
      await snapshot.cleanup();
      expect(events.at(-1)).toEqual(["remove", temp]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

describe("bounded process-tree supervision", () => {
  it("TERM/grace/KILLs the owned process group and waits for its descendants", async () => {
    const script = [
      "const {spawn}=require('node:child_process')",
      "process.on('SIGTERM',()=>{})",
      "const child=spawn(process.execPath,['-e',`process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`],{stdio:'ignore'})",
      "console.log(child.pid)",
      "setInterval(()=>{},1000)",
    ].join(";");
    const result = await subject.spawnBounded(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      env: {},
      timeoutMs: 100,
      termGraceMs: 100,
      maxOutputBytes: 1_024,
    });
    expect(result.timedOut).toBe(true);
    expect(result.reaped).toBe(true);
    const descendantPid = Number(result.stdout.trim());
    expect(Number.isInteger(descendantPid)).toBe(true);
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });
});
