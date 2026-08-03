import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import * as subject from "./vercel-development.mjs";

const DEVELOPMENT_PROJECT_ID = "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA";
const DEVELOPMENT_PROJECT_NAME = "harness-arena-development";
const LIVE_PROJECT_ID = "prj_f4ppu0xpO0LZeHOAH99RHotVbwyo";
const TEAM_ID = "team_cwyLpng8LCwWgINdiQ27hHYa";
const REVIEWED_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const LIVE_STORE_ID = "store_SgaF1fm7nkPQPCKq";
const DEVELOPMENT_STORE_ID = "store_development";
const TOKEN = "test-vercel-token-never-print";
const UPSTREAM_URL = "https://github.com/dennisonbertram/harness-arena.git";
const execFileAsync = promisify(execFile);

function manifest(overrides = {}) {
  return {
    environment: "development",
    branch: "dev",
    git: {
      provider: "github",
      repository: "dennisonbertram/harness-arena",
      productionBranch: "dev",
    },
    vercelProject: { id: DEVELOPMENT_PROJECT_ID, name: DEVELOPMENT_PROJECT_NAME },
    host: "harness-arena-development.vercel.app",
    store: { id: DEVELOPMENT_STORE_ID },
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

function inspection(overrides = {}) {
  return {
    project: {
      id: DEVELOPMENT_PROJECT_ID,
      ownerId: TEAM_ID,
      name: DEVELOPMENT_PROJECT_NAME,
      git: {
        type: "github",
        org: "dennisonbertram",
        repo: "harness-arena",
        productionBranch: "dev",
      },
      aliases: [{
        domain: "harness-arena-development.vercel.app",
        environment: "production",
        target: "PRODUCTION",
        redirect: undefined,
      }],
    },
    environment: {
      callbackBase: "https://harness-arena-development.vercel.app",
      networkModeConfigured: false,
      blobStoreId: DEVELOPMENT_STORE_ID,
      storeIds: [DEVELOPMENT_STORE_ID],
    },
    store: {
      id: DEVELOPMENT_STORE_ID,
      ownerId: TEAM_ID,
      projectId: DEVELOPMENT_PROJECT_ID,
      type: "blob",
    },
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  return {
    cwd: "/repo",
    reviewedSha: REVIEWED_SHA,
    token: TOKEN,
    inheritedEnv: {},
    readManifest: vi.fn(async () => manifest()),
    readRemoteSha: vi.fn()
      .mockResolvedValueOnce(REVIEWED_SHA)
      .mockResolvedValueOnce(REVIEWED_SHA),
    readOnlyApi: { inspect: vi.fn(async () => inspection()) },
    ...overrides,
  };
}

async function expectDenied(deps) {
  await expect(subject.verifyDevelopmentPreflight(deps)).rejects.toThrow(/read-only preflight denied/i);
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function productionDomain(overrides = {}) {
  return {
    name: "harness-arena-development.vercel.app",
    apexName: "vercel.app",
    projectId: DEVELOPMENT_PROJECT_ID,
    verified: true,
    ...overrides,
  };
}

function verifierApiFetch({
  aliases,
  domains,
  domainsAfter,
  pagination,
  envs,
  liveAliases = manifest().live.aliases,
  liveAliasesAfter = liveAliases,
  liveStoreIds = manifest().live.storeIds,
  liveStoreIdsAfter = liveStoreIds,
  liveStoreTargets = ["production"],
  liveDeployment = {},
  liveEnvironment = {},
}) {
  const project = {
    id: DEVELOPMENT_PROJECT_ID,
    accountId: TEAM_ID,
    name: DEVELOPMENT_PROJECT_NAME,
    link: { type: "github", org: "dennisonbertram", repo: "harness-arena", productionBranch: "dev" },
    alias: aliases ?? [],
  };
  let domainReads = 0;
  let liveReads = 0;
  let liveEnvironmentReads = 0;
  return vi.fn(async (input) => {
    const url = new URL(input);
    if (url.pathname === `/v9/projects/${DEVELOPMENT_PROJECT_ID}`) return jsonResponse(project);
    if (url.pathname === `/v9/projects/${DEVELOPMENT_PROJECT_ID}/domains`) {
      domainReads += 1;
      const inventory = {
        domains: domainReads === 1 ? (domains ?? [productionDomain()]) : (domainsAfter ?? domains ?? [productionDomain()]),
      };
      inventory.pagination = pagination ?? { count: inventory.domains.length, next: null, prev: null };
      return jsonResponse(inventory);
    }
    if (url.pathname === `/v13/deployments/${encodeURIComponent(manifest().live.aliases[0])}`) {
      liveReads += 1;
      return jsonResponse({
        projectId: LIVE_PROJECT_ID,
        target: "production",
        readyState: "READY",
        alias: liveReads === 1 ? liveAliases : liveAliasesAfter,
        ...liveDeployment,
      });
    }
    if (url.pathname === `/v10/projects/${LIVE_PROJECT_ID}/env`) {
      liveEnvironmentReads += 1;
      const storeIds = liveEnvironmentReads === 1 ? liveStoreIds : liveStoreIdsAfter;
      return jsonResponse({
        envs: storeIds.map((storeId) => ({ target: liveStoreTargets, contentHint: { storeId } })),
        hiddenProductionEnvCount: 0,
        ...liveEnvironment,
      });
    }
    if (url.pathname === `/v10/projects/${DEVELOPMENT_PROJECT_ID}/env`) {
      return jsonResponse({ envs: envs ?? [
        { id: "env_callback", key: "CALLBACK_BASE", target: ["production"] },
        {
          id: "env_blob",
          key: "BLOB_READ_WRITE_TOKEN",
          target: ["production"],
          contentHint: { storeId: DEVELOPMENT_STORE_ID },
        },
      ] });
    }
    if (url.pathname.endsWith("/env/env_callback")) {
      return jsonResponse({ value: "https://harness-arena-development.vercel.app" });
    }
    if (url.pathname === `/v1/storage/stores/${DEVELOPMENT_STORE_ID}`) {
      return jsonResponse({
        id: DEVELOPMENT_STORE_ID,
        ownerId: TEAM_ID,
        type: "blob",
        projects: [{ projectId: DEVELOPMENT_PROJECT_ID }],
      });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  });
}

describe("native-Git Development project verifier", () => {
  it("is read-only and proves the exact stable remote dev SHA plus isolated project settings", async () => {
    const deps = dependencies();

    await expect(subject.verifyDevelopmentPreflight(deps)).resolves.toEqual({
      ok: true,
      reviewedSha: REVIEWED_SHA,
      remote: { url: UPSTREAM_URL, ref: "refs/heads/dev", sha: REVIEWED_SHA },
      project: {
        id: DEVELOPMENT_PROJECT_ID,
        name: DEVELOPMENT_PROJECT_NAME,
        productionBranch: "dev",
      },
    });

    expect(deps.readRemoteSha).toHaveBeenCalledTimes(2);
    expect(deps.readOnlyApi.inspect).toHaveBeenCalledTimes(1);
  });

  it("exports no archive, process-spawn, deploy, or postflight mutation machinery", () => {
    expect(subject.runDevelopmentVercelOperation).toBeUndefined();
    expect(subject.createReviewedSnapshot).toBeUndefined();
    expect(subject.validateTarArchive).toBeUndefined();
    expect(subject.spawnBounded).toBeUndefined();
  });

  it.each([
    ["symbolic SHA", "HEAD", REVIEWED_SHA, REVIEWED_SHA],
    ["different initial remote tip", REVIEWED_SHA, OTHER_SHA, OTHER_SHA],
    ["remote tip changed during verification", REVIEWED_SHA, REVIEWED_SHA, OTHER_SHA],
  ])("rejects %s", async (_name, reviewedSha, firstSha, secondSha) => {
    const deps = dependencies({
      reviewedSha,
      readRemoteSha: vi.fn().mockResolvedValueOnce(firstSha).mockResolvedValueOnce(secondSha),
    });
    await expectDenied(deps);
  });

  it.each([
    ["live project", inspection({ project: { ...inspection().project, id: LIVE_PROJECT_ID } })],
    ["wrong project name", inspection({ project: { ...inspection().project, name: "harness-arena" } })],
    ["wrong owner", inspection({ project: { ...inspection().project, ownerId: "team_other" } })],
    ["non-GitHub link", inspection({ project: { ...inspection().project, git: { ...inspection().project.git, type: "gitlab" } } })],
    ["wrong repository", inspection({ project: { ...inspection().project, git: { ...inspection().project.git, repo: "other" } } })],
    ["wrong production branch", inspection({ project: { ...inspection().project, git: { ...inspection().project.git, productionBranch: "main" } } })],
    ["live alias", inspection({
      project: {
        ...inspection().project,
        aliases: [{ ...inspection().project.aliases[0], domain: manifest().live.aliases[0] }],
      },
    })],
    ["live callback", inspection({ environment: { ...inspection().environment, callbackBase: `https://${manifest().live.aliases[0]}` } })],
    ["live store metadata", inspection({ environment: { ...inspection().environment, storeIds: [LIVE_STORE_ID] } })],
    ["live connected store", inspection({ store: { ...inspection().store, id: LIVE_STORE_ID } })],
    ["allow-all Vercel setting", inspection({ environment: { ...inspection().environment, networkModeConfigured: true } })],
    ["unknown response field", { ...inspection(), target: "production" }],
  ])("fails closed on %s", async (_name, actual) => {
    await expectDenied(dependencies({ readOnlyApi: { inspect: vi.fn(async () => actual) } }));
  });

  it("rejects RUNNER_NETWORK_MODE=allow-all from its own Vercel invocation context", async () => {
    await expectDenied(dependencies({ inheritedEnv: { VERCEL: "1", RUNNER_NETWORK_MODE: "allow-all" } }));
  });

  it("rejects every operation argument other than the read-only verify command", async () => {
    await expectDenied(dependencies({ operation: "deploy" }));
  });
});

describe("trusted remote Git provenance", () => {
  it("ignores replacement refs and repository/global insteadOf config and resolves outside the repository", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "issue175-spoofed-repo-"));
    const calls = [];
    try {
      await execFileAsync("/usr/bin/git", ["init", "--quiet"], { cwd: repo });
      await execFileAsync("/usr/bin/git", ["config", "url.https://attacker.invalid/.insteadOf", UPSTREAM_URL], { cwd: repo });
      await execFileAsync("/usr/bin/git", ["config", "core.useReplaceRefs", "true"], { cwd: repo });
      await mkdir(path.join(repo, ".git", "refs", "replace"), { recursive: true });
      await writeFile(path.join(repo, ".git", "refs", "replace", REVIEWED_SHA), `${OTHER_SHA}\n`);

      const sha = await subject.readTrustedRemoteDevSha({
        cwd: repo,
        execFileImpl: async (file, args, options) => {
          calls.push({ file, args, options });
          return { stdout: `${REVIEWED_SHA}\trefs/heads/dev\n` };
        },
      });

      expect(sha).toBe(REVIEWED_SHA);
      expect(calls).toHaveLength(1);
      expect(calls[0].file).toBe("/usr/bin/git");
      expect(calls[0].args).toEqual([
        "--no-replace-objects",
        "ls-remote",
        "--exit-code",
        UPSTREAM_URL,
        "refs/heads/dev",
      ]);
      expect(path.resolve(calls[0].options.cwd)).not.toBe(path.resolve(repo));
      expect(calls[0].options.env).toEqual({
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        HOME: "/dev/null",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it.each([
    ["wrong ref", `${REVIEWED_SHA}\trefs/heads/main\n`],
    ["multiple lines", `${REVIEWED_SHA}\trefs/heads/dev\n${OTHER_SHA}\trefs/heads/dev\n`],
    ["symbolic output", `ref: refs/heads/dev\tHEAD\n`],
  ])("rejects malformed ls-remote output: %s", async (_name, stdout) => {
    await expect(subject.readTrustedRemoteDevSha({
      cwd: "/repo",
      execFileImpl: async () => ({ stdout }),
    })).rejects.toThrow(/read-only preflight denied/i);
  });
});

describe("bounded read-only Vercel adapter", () => {
  it("accepts the real live environment shape and multi-target Blob binding", async () => {
    const api = subject.createReadOnlyVercelApi({
      fetchImpl: verifierApiFetch({
        liveStoreTargets: ["production", "preview", "development"],
        liveEnvironment: { hiddenProductionEnvCount: 0 },
      }),
    });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
      live: manifest().live,
    })).resolves.toEqual(inspection());
  });

  it("rejects live aliases that are absent from the manifest inventory", async () => {
    const api = subject.createReadOnlyVercelApi({
      fetchImpl: verifierApiFetch({ liveAliases: [...manifest().live.aliases, "unrecorded-live.vercel.app"] }),
    });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
      live: manifest().live,
    })).rejects.toThrow(/^Development Vercel read-only preflight denied by local safety policy$/);
  });

  it("uses stable GET-only live inventory metadata without decrypting it", async () => {
    const fetchImpl = verifierApiFetch({});
    const api = subject.createReadOnlyVercelApi({ fetchImpl });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
      live: manifest().live,
    })).resolves.toEqual(inspection());

    const liveRequests = fetchImpl.mock.calls.map(([input]) => new URL(input)).filter((url) =>
      url.pathname === `/v13/deployments/${manifest().live.aliases[0]}`
      || url.pathname === `/v10/projects/${LIVE_PROJECT_ID}/env`,
    );
    expect(liveRequests).toHaveLength(4);
    expect(liveRequests.filter((url) => url.pathname.startsWith("/v13/deployments/")).every((url) =>
      url.searchParams.get("withGitRepoInfo") === "true",
    )).toBe(true);
    expect(liveRequests.every((url) => url.searchParams.get("decrypt") === null)).toBe(true);
  });

  it.each([
    ["replaced production Blob store", { liveStoreIds: ["store_replaced"] }],
    ["cross-project deployment", { liveDeployment: { projectId: DEVELOPMENT_PROJECT_ID } }],
    ["non-ready deployment", { liveDeployment: { readyState: "BUILDING" } }],
    ["non-production deployment", { liveDeployment: { target: "staging" } }],
    ["paginated environment response", { liveEnvironment: { pagination: { count: 1, next: null, prev: null } } }],
    [
      "non-production Blob binding",
      { liveEnvironment: { envs: [{ target: ["preview"], contentHint: { storeId: LIVE_STORE_ID } }] } },
    ],
    ["unstable alias inventory", { liveAliasesAfter: [manifest().live.aliases[0]] }],
  ])("rejects unsafe live inventory evidence: %s", async (_name, options) => {
    const api = subject.createReadOnlyVercelApi({ fetchImpl: verifierApiFetch(options) });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
      live: manifest().live,
    })).rejects.toThrow(/^Development Vercel read-only preflight denied by local safety policy$/);
  });

  it.each([
    ["hidden production metadata", { liveEnvironment: { hiddenProductionEnvCount: 1 } }],
    ["malformed target", { liveStoreTargets: ["production", "unknown"] }],
    ["duplicate target", { liveStoreTargets: ["production", "production"] }],
    ["production absent", { liveStoreTargets: ["preview"] }],
  ])("rejects incomplete live store targeting evidence: %s", async (_name, options) => {
    const api = subject.createReadOnlyVercelApi({ fetchImpl: verifierApiFetch(options) });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
      live: manifest().live,
    })).rejects.toThrow(/^Development Vercel read-only preflight denied by local safety policy$/);
  });

  it("accepts the complete final-page domain inventory metadata", async () => {
    const api = subject.createReadOnlyVercelApi({
      fetchImpl: verifierApiFetch({ pagination: { count: 1, next: null, prev: 1785709088100 } }),
    });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    })).resolves.toEqual(inspection());
  });

  it("uses the verified stable domain inventory when project aliases are empty", async () => {
    const fetchImpl = verifierApiFetch({ aliases: [] });
    const api = subject.createReadOnlyVercelApi({ fetchImpl });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    })).resolves.toEqual(inspection());

    expect(fetchImpl.mock.calls.filter(([input]) => new URL(input).pathname.endsWith("/domains"))).toHaveLength(2);
  });

  it.each([
    ["non-matching count", { count: 2, next: null, prev: null }],
    ["unsafe cursor", { count: 1, next: 1785709088100, prev: null }],
    ["malformed cursor", { count: 1, next: null, prev: -1 }],
  ])("rejects incomplete or malformed domain pagination: %s", async (_name, pagination) => {
    const api = subject.createReadOnlyVercelApi({ fetchImpl: verifierApiFetch({ pagination }) });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    })).rejects.toThrow(/^Development Vercel read-only preflight denied by local safety policy$/);
  });

  it.each([
    [
      "copied duplicate metadata",
      [
        { id: "env_blob", key: "BLOB_READ_WRITE_TOKEN", target: ["production"], contentHint: { storeId: DEVELOPMENT_STORE_ID } },
        { id: "env_blob_copy", key: "BLOB_READ_WRITE_TOKEN", target: ["production"], contentHint: { storeId: DEVELOPMENT_STORE_ID } },
      ],
    ],
    [
      "an unknown store",
      [{ id: "env_blob", key: "BLOB_READ_WRITE_TOKEN", target: ["production"], contentHint: { storeId: "store_unknown" } }],
    ],
    [
      "the live store",
      [{ id: "env_blob", key: "BLOB_READ_WRITE_TOKEN", target: ["production"], contentHint: { storeId: LIVE_STORE_ID } }],
    ],
    [
      "raw token metadata without a content hint",
      [{ id: "env_blob", key: "BLOB_READ_WRITE_TOKEN", target: ["production"], value: "raw-token-never-print" }],
    ],
  ])("rejects BLOB_READ_WRITE_TOKEN bound through %s even when an unused variable hints at the Development store", async (_name, blobEntries) => {
    const api = subject.createReadOnlyVercelApi({
      fetchImpl: verifierApiFetch({
        envs: [
          { id: "env_callback", key: "CALLBACK_BASE", target: ["production"] },
          { id: "env_unused", key: "UNUSED_STORE_URL", target: ["production"], contentHint: { storeId: DEVELOPMENT_STORE_ID } },
          ...blobEntries,
        ],
      }),
    });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    })).rejects.toThrow(/^Development Vercel read-only preflight denied by local safety policy$/);
  });

  it.each([
    ["redirect", productionDomain({ redirect: manifest().live.aliases[0] })],
    ["git branch", productionDomain({ gitBranch: "dev" })],
    ["custom environment", productionDomain({ customEnvironmentId: "env_development" })],
    ["unverified", productionDomain({ verified: false })],
    ["malformed", { ...productionDomain(), name: 7 }],
  ])("rejects unsafe project domain inventory entries: %s", async (_name, domain) => {
    const api = subject.createReadOnlyVercelApi({
      fetchImpl: verifierApiFetch({ domains: [domain] }),
    });
    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    })).rejects.toThrow(/^Development Vercel read-only preflight denied by local safety policy$/);
  });

  it("returns a live alias only for the preflight to reject", async () => {
    const api = subject.createReadOnlyVercelApi({
      fetchImpl: verifierApiFetch({ domains: [productionDomain({ name: manifest().live.aliases[0] })] }),
    });
    const actual = await api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    });

    expect(actual.project.aliases[0].domain).toBe(manifest().live.aliases[0]);
    await expectDenied(dependencies({ readOnlyApi: { inspect: vi.fn(async () => actual) } }));
  });

  it("fails closed when the domain inventory changes during inspection", async () => {
    const api = subject.createReadOnlyVercelApi({
      fetchImpl: verifierApiFetch({
        domainsAfter: [productionDomain({ name: "replacement-development.vercel.app" })],
      }),
    });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    })).rejects.toThrow(/^Development Vercel read-only preflight denied by local safety policy$/);
  });

  it("uses only fixed GET requests, rechecks project settings, and decrypts only CALLBACK_BASE", async () => {
    const requests = [];
    const project = {
      id: DEVELOPMENT_PROJECT_ID,
      accountId: TEAM_ID,
      name: DEVELOPMENT_PROJECT_NAME,
      link: { type: "github", org: "dennisonbertram", repo: "harness-arena", productionBranch: "dev" },
      alias: [],
    };
    const fetchImpl = vi.fn(async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.pathname === `/v9/projects/${DEVELOPMENT_PROJECT_ID}`) return jsonResponse(project);
      if (url.pathname === `/v9/projects/${DEVELOPMENT_PROJECT_ID}/domains`) {
        return jsonResponse({ domains: [productionDomain()], pagination: { count: 1, next: null, prev: null } });
      }
      if (url.pathname === `/v10/projects/${DEVELOPMENT_PROJECT_ID}/env`) {
        return jsonResponse({ envs: [
          { id: "env_callback", key: "CALLBACK_BASE", target: ["production"] },
          { id: "env_blob", key: "BLOB_READ_WRITE_TOKEN", target: ["production"], contentHint: { storeId: DEVELOPMENT_STORE_ID } },
        ] });
      }
      if (url.pathname.endsWith("/env/env_callback")) {
        return jsonResponse({ value: "https://harness-arena-development.vercel.app" });
      }
      if (url.pathname === `/v1/storage/stores/${DEVELOPMENT_STORE_ID}`) {
        return jsonResponse({
          id: DEVELOPMENT_STORE_ID,
          ownerId: TEAM_ID,
          type: "blob",
          projects: [{ projectId: DEVELOPMENT_PROJECT_ID }],
        });
      }
      throw new Error(`unexpected request ${url.pathname}`);
    });

    const api = subject.createReadOnlyVercelApi({ fetchImpl });
    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    })).resolves.toEqual(inspection());

    expect(requests).toHaveLength(7);
    expect(requests.every(({ options }) => options.method === "GET")).toBe(true);
    expect(requests.every(({ options }) => options.redirect === "error")).toBe(true);
    expect(requests.filter(({ url }) => url.searchParams.get("decrypt") === "true"))
      .toHaveLength(1);
    expect(requests.filter(({ url }) => url.pathname.endsWith("/domains")))
      .toHaveLength(2);
    expect(requests.filter(({ url }) => url.pathname.endsWith("/domains")).every(({ url }) => url.searchParams.get("limit") === "100"))
      .toBe(true);
    expect(requests.find(({ url }) => url.searchParams.get("decrypt") === "true").url.pathname)
      .toMatch(/env_callback$/);
  });

  it("bounds response bodies", async () => {
    const api = subject.createReadOnlyVercelApi({
      fetchImpl: vi.fn(async () => new Response("x".repeat(2_000), { status: 200 })),
      maxBodyBytes: 1_024,
    });
    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    })).rejects.toThrow(/read-only preflight denied/i);
  });

  it("fails closed when project linkage changes during inspection", async () => {
    let projectReads = 0;
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(input);
      if (url.pathname === `/v9/projects/${DEVELOPMENT_PROJECT_ID}`) {
        projectReads += 1;
        return jsonResponse({
          id: DEVELOPMENT_PROJECT_ID,
          accountId: TEAM_ID,
          name: DEVELOPMENT_PROJECT_NAME,
          link: {
            type: "github",
            org: "dennisonbertram",
            repo: "harness-arena",
            productionBranch: projectReads === 1 ? "dev" : "main",
          },
          alias: [{ domain: "harness-arena-development.vercel.app" }],
        });
      }
      if (url.pathname === `/v9/projects/${DEVELOPMENT_PROJECT_ID}/domains`) {
        return jsonResponse({ domains: [productionDomain()], pagination: { count: 1, next: null, prev: null } });
      }
      if (url.pathname === `/v10/projects/${DEVELOPMENT_PROJECT_ID}/env`) {
        return jsonResponse({ envs: [
          { id: "env_callback", key: "CALLBACK_BASE", target: ["production"] },
          { key: "BLOB_READ_WRITE_TOKEN", target: ["production"], contentHint: { storeId: DEVELOPMENT_STORE_ID } },
        ] });
      }
      if (url.pathname.endsWith("/env/env_callback")) {
        return jsonResponse({ value: "https://harness-arena-development.vercel.app" });
      }
      if (url.pathname === `/v1/storage/stores/${DEVELOPMENT_STORE_ID}`) {
        return jsonResponse({
          id: DEVELOPMENT_STORE_ID,
          ownerId: TEAM_ID,
          type: "blob",
          projects: [{ projectId: DEVELOPMENT_PROJECT_ID }],
        });
      }
      throw new Error(`unexpected request ${url.pathname}`);
    });
    const api = subject.createReadOnlyVercelApi({ fetchImpl });
    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    })).rejects.toThrow(/read-only preflight denied/i);
    expect(projectReads).toBe(2);
  });

  it("bounds request time", async () => {
    const api = subject.createReadOnlyVercelApi({
      fetchImpl: vi.fn((_input, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })),
      timeoutMs: 10,
    });
    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    })).rejects.toThrow(/read-only preflight denied/i);
  });
});

describe("Development runbook contract", () => {
  it("assigns deployment ownership to native Git and documents only read-only verification", async () => {
    const [runbook, agents] = await Promise.all([
      readFile(new URL("../../docs/runbooks/development-environment.md", import.meta.url), "utf8"),
      readFile(new URL("../../AGENTS.md", import.meta.url), "utf8"),
    ]);
    expect(runbook).toMatch(/Vercel native Git integration/i);
    expect(runbook).toMatch(/Production Branch[^\n]*`dev`/i);
    expect(runbook).toContain("node scripts/ops/vercel-development.mjs verify <exact-reviewed-origin-dev-sha>");
    expect(runbook).not.toMatch(/vercel-development\.mjs deploy|vercel deploy/i);
    expect(agents).not.toMatch(/vercel-development\.mjs deploy/i);
    expect(agents).toMatch(/native Git/i);
  });
});
