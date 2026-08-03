import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import * as subject from "./vercel-development.mjs";

const DEVELOPMENT_PROJECT_ID = "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA";
const DEVELOPMENT_PROJECT_NAME = "harness-arena-development";
const DEVELOPMENT_STORE_NAME = "harness-arena-development-data";
const LIVE_PROJECT_ID = "prj_f4ppu0xpO0LZeHOAH99RHotVbwyo";
const TEAM_ID = "team_cwyLpng8LCwWgINdiQ27hHYa";
const REVIEWED_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const LIVE_STORE_ID = "store_SgaF1fm7nkPQPCKq";
const DEVELOPMENT_STORE_ID = "store_development";
const TOKEN = "test-vercel-token-never-print";
const UPSTREAM_URL = "https://github.com/dennisonbertram/harness-arena.git";
const execFileAsync = promisify(execFile);
const HOSTED_ACCEPTANCE = {
  runsPerSubmission: 1,
  maxConcurrentRuns: 1,
  maxStartsPerTick: 1,
  runBudgetCapUsd: 0.25,
  runnerAgentTimeoutCapSeconds: 30,
  runnerVerifyTimeoutCapSeconds: 30,
  runnerSandboxTimeoutMinutes: 60,
  gatewayProjectBudgetUsd: 1,
};
const HOSTED_ACCEPTANCE_ENV = {
  RUNS_PER_SUBMISSION: "runsPerSubmission",
  MAX_CONCURRENT_RUNS: "maxConcurrentRuns",
  MAX_STARTS_PER_TICK: "maxStartsPerTick",
  RUN_BUDGET_CAP_USD: "runBudgetCapUsd",
  RUNNER_AGENT_TIMEOUT_CAP: "runnerAgentTimeoutCapSeconds",
  RUNNER_VERIFY_TIMEOUT_CAP: "runnerVerifyTimeoutCapSeconds",
  RUNNER_SANDBOX_TIMEOUT_MIN: "runnerSandboxTimeoutMinutes",
};
const DEVELOPMENT_GATEWAY_KEY_ID = "gateway-key-development";
const DEVELOPMENT_GATEWAY_KEY_PARTIAL = "abc";

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
    hostedAcceptance: HOSTED_ACCEPTANCE,
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
      hostedAcceptance: Object.fromEntries(Object.entries(HOSTED_ACCEPTANCE_ENV).map(([, acceptanceKey]) => [
        acceptanceKey,
        String(HOSTED_ACCEPTANCE[acceptanceKey]),
      ])),
      gatewayBudget: {
        keyId: DEVELOPMENT_GATEWAY_KEY_ID,
        keyName: "harness-arena-development-acceptance",
        keyPartial: DEVELOPMENT_GATEWAY_KEY_PARTIAL,
        quotaEntityId: `api_key_id_${DEVELOPMENT_GATEWAY_KEY_ID}`,
        limitAmount: 1,
        currentSpend: 0,
        refreshPeriod: "monthly",
        active: true,
        archived: false,
      },
    },
    store: {
      id: DEVELOPMENT_STORE_ID,
      ownerId: TEAM_ID,
      projectId: DEVELOPMENT_PROJECT_ID,
      type: "blob",
      access: "private",
      status: "available",
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

function developmentStoreResponse(overrides = {}) {
  return {
    store: {
      ...currentDevelopmentStoreResponse().store,
      ...overrides,
    },
  };
}

function currentDevelopmentStoreResponse() {
  return {
    store: {
      access: "private",
      billingState: "active",
      count: 0,
      createdAt: 1785709088100,
      id: DEVELOPMENT_STORE_ID,
      isTokenExpired: false,
      name: DEVELOPMENT_STORE_NAME,
      ownerId: TEAM_ID,
      projectsMetadata: [{
        envVarPrefix: "BLOB",
        environmentVariables: ["BLOB_READ_WRITE_TOKEN"],
        environments: ["production", "preview", "development"],
        framework: "nextjs",
        id: "spc_development",
        latestDeployment: null,
        name: DEVELOPMENT_PROJECT_NAME,
        projectId: DEVELOPMENT_PROJECT_ID,
      }],
      region: "iad1",
      size: 0,
      status: "available",
      totalConnectedProjects: 1,
      type: "blob",
      updatedAt: 1785709088100,
      usageQuotaExceeded: false,
    },
  };
}

function acceptanceEnvironmentEntries() {
  return Object.keys(HOSTED_ACCEPTANCE_ENV).map((key) => ({
    id: `env_${key.toLowerCase()}`,
    key,
    target: ["production"],
    type: "encrypted",
  }));
}

function gatewayBindingEnvironmentEntries() {
  return [
    { id: "env_gateway_key_id", key: "AI_GATEWAY_KEY_ID", target: ["production"], type: "encrypted" },
    { id: "env_gateway_key_partial", key: "AI_GATEWAY_KEY_PARTIAL", target: ["production"], type: "encrypted" },
  ];
}

function developmentGatewayKey(overrides = {}) {
  return {
    activeAt: 1785709088100,
    createdAt: 1785709088100,
    createdBy: "user_development",
    createdByAppId: null,
    expiresAt: null,
    id: DEVELOPMENT_GATEWAY_KEY_ID,
    leakedAt: null,
    leakedUrl: null,
    name: "harness-arena-development-acceptance",
    partialKey: DEVELOPMENT_GATEWAY_KEY_PARTIAL,
    projectId: DEVELOPMENT_PROJECT_ID,
    purpose: "ai-gateway",
    quota: {
      active: true,
      archived: false,
      createdAt: 1785709088100,
      currentByokSpend: 0,
      currentSpend: 0,
      includeByokInQuota: true,
      limitAmount: 1,
      quotaEntityId: `api_key_id_${DEVELOPMENT_GATEWAY_KEY_ID}`,
      refreshPeriod: "monthly",
      updatedAt: 1785709088100,
    },
    teamId: TEAM_ID,
    ...overrides,
  };
}

function decryptedEnvironmentValue(entry, value) {
  return {
    configurationId: null,
    createdAt: 1785709088100,
    createdBy: "user_development",
    decrypted: true,
    id: entry.id,
    key: entry.key,
    target: entry.target,
    type: entry.type,
    updatedAt: 1785709088100,
    updatedBy: null,
    value,
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
  developmentStore,
  gatewayKeys,
  runtimeValues = {},
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
    const developmentEnvs = envs ?? [
        { id: "env_callback", key: "CALLBACK_BASE", target: ["production"], type: "encrypted" },
        {
          id: "env_blob",
          key: "BLOB_READ_WRITE_TOKEN",
          target: ["production"],
          contentHint: { storeId: DEVELOPMENT_STORE_ID },
        },
        { id: "env_gateway", key: "AI_GATEWAY_API_KEY", target: ["production"], type: "sensitive" },
        ...acceptanceEnvironmentEntries(),
        ...gatewayBindingEnvironmentEntries(),
      ];
    if (url.pathname === `/v10/projects/${DEVELOPMENT_PROJECT_ID}/env`) {
      return jsonResponse({ envs: developmentEnvs });
    }
    const environmentEntry = developmentEnvs.find((entry) => url.pathname.endsWith(`/env/${entry.id}`));
    if (environmentEntry) {
      if (environmentEntry.key === "CALLBACK_BASE") {
        return jsonResponse(decryptedEnvironmentValue(environmentEntry, "https://harness-arena-development.vercel.app"));
      }
      const acceptanceKey = HOSTED_ACCEPTANCE_ENV[environmentEntry.key];
      if (acceptanceKey) {
        return jsonResponse(decryptedEnvironmentValue(
          environmentEntry,
          runtimeValues[environmentEntry.key] ?? String(HOSTED_ACCEPTANCE[acceptanceKey]),
        ));
      }
      if (environmentEntry.key === "AI_GATEWAY_KEY_ID") {
        return jsonResponse(decryptedEnvironmentValue(environmentEntry, runtimeValues.AI_GATEWAY_KEY_ID ?? DEVELOPMENT_GATEWAY_KEY_ID));
      }
      if (environmentEntry.key === "AI_GATEWAY_KEY_PARTIAL") {
        return jsonResponse(decryptedEnvironmentValue(environmentEntry, runtimeValues.AI_GATEWAY_KEY_PARTIAL ?? DEVELOPMENT_GATEWAY_KEY_PARTIAL));
      }
      throw new Error(`unexpected environment value read ${environmentEntry.key}`);
    }
    if (url.pathname === "/v1/api-keys") {
      return jsonResponse({
        apiKeys: gatewayKeys ?? [developmentGatewayKey()],
        pagination: { count: (gatewayKeys ?? [developmentGatewayKey()]).length, next: null, prev: null },
      });
    }
    if (url.pathname === `/v1/storage/stores/${DEVELOPMENT_STORE_ID}`) {
      return jsonResponse(developmentStore ?? developmentStoreResponse());
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
  it("accepts the current complete nested Blob store shape", async () => {
    const api = subject.createReadOnlyVercelApi({
      fetchImpl: verifierApiFetch({ developmentStore: currentDevelopmentStoreResponse() }),
    });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    })).resolves.toEqual(inspection());
  });

  it("rejects a Development project that lacks any declared hosted acceptance runtime control", async () => {
    const api = subject.createReadOnlyVercelApi({
      fetchImpl: verifierApiFetch({ envs: [
        { id: "env_callback", key: "CALLBACK_BASE", target: ["production"], type: "encrypted" },
        { id: "env_blob", key: "BLOB_READ_WRITE_TOKEN", target: ["production"], contentHint: { storeId: DEVELOPMENT_STORE_ID } },
        { id: "env_gateway", key: "AI_GATEWAY_API_KEY", target: ["production"], type: "sensitive" },
      ] }),
    });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
      live: manifest().live,
    })).rejects.toThrow(/^Development Vercel read-only preflight denied by local safety policy$/);
  });

  it("rejects a Development project with no active project-scoped Gateway quota", async () => {
    const api = subject.createReadOnlyVercelApi({ fetchImpl: verifierApiFetch({ gatewayKeys: [] }) });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
      live: manifest().live,
    })).rejects.toThrow(/^Development Vercel read-only preflight denied by local safety policy$/);
  });

  it("rejects a widened runtime acceptance value, scope, or metadata type", async () => {
    const widened = subject.createReadOnlyVercelApi({
      fetchImpl: verifierApiFetch({ runtimeValues: { RUNS_PER_SUBMISSION: "5" } }),
    });
    const widenedScope = subject.createReadOnlyVercelApi({
      fetchImpl: verifierApiFetch({ envs: [
        { id: "env_callback", key: "CALLBACK_BASE", target: ["production"], type: "encrypted" },
        { id: "env_blob", key: "BLOB_READ_WRITE_TOKEN", target: ["production"], contentHint: { storeId: DEVELOPMENT_STORE_ID } },
        { id: "env_gateway", key: "AI_GATEWAY_API_KEY", target: ["production"], type: "sensitive" },
        ...acceptanceEnvironmentEntries().map((entry) => entry.key === "MAX_CONCURRENT_RUNS"
          ? { ...entry, target: ["production", "preview"] }
          : entry),
      ] }),
    });
    const wrongType = subject.createReadOnlyVercelApi({
      fetchImpl: verifierApiFetch({ envs: [
        { id: "env_callback", key: "CALLBACK_BASE", target: ["production"], type: "encrypted" },
        { id: "env_blob", key: "BLOB_READ_WRITE_TOKEN", target: ["production"], contentHint: { storeId: DEVELOPMENT_STORE_ID } },
        { id: "env_gateway", key: "AI_GATEWAY_API_KEY", target: ["production"], type: "sensitive" },
        ...acceptanceEnvironmentEntries().map((entry) => entry.key === "RUN_BUDGET_CAP_USD"
          ? { ...entry, type: "plain" }
          : entry),
      ] }),
    });

    const input = { projectId: DEVELOPMENT_PROJECT_ID, teamId: TEAM_ID, storeId: DEVELOPMENT_STORE_ID, token: TOKEN };
    await expect(widened.inspect(input)).rejects.toThrow(/read-only preflight denied/i);
    await expect(widenedScope.inspect(input)).rejects.toThrow(/read-only preflight denied/i);
    await expect(wrongType.inspect(input)).rejects.toThrow(/read-only preflight denied/i);
  });

  it.each([
    ["inactive", [developmentGatewayKey({ quota: { ...developmentGatewayKey().quota, active: false } })]],
    ["wrong project quota entity", [developmentGatewayKey({ quota: { ...developmentGatewayKey().quota, quotaEntityId: "api_key_id_other" } })]],
  ])("rejects a %s Gateway quota", async (_name, gatewayKeys) => {
    const api = subject.createReadOnlyVercelApi({ fetchImpl: verifierApiFetch({ gatewayKeys }) });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    })).rejects.toThrow(/read-only preflight denied/i);
  });

  it.each([
    ["key id", { AI_GATEWAY_KEY_ID: "other-key" }],
    ["key partial", { AI_GATEWAY_KEY_PARTIAL: "wrong" }],
  ])("rejects a mismatched Gateway %s binding", async (_name, runtimeValues) => {
    const api = subject.createReadOnlyVercelApi({ fetchImpl: verifierApiFetch({ runtimeValues }) });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    })).rejects.toThrow(/read-only preflight denied/i);
  });

  it.each(["RUNNER_PROVIDER", "OPENROUTER_API_KEY"])("rejects alternate provider configuration %s", async (key) => {
    const api = subject.createReadOnlyVercelApi({
      fetchImpl: verifierApiFetch({ envs: [
        { id: "env_callback", key: "CALLBACK_BASE", target: ["production"], type: "encrypted" },
        { id: "env_blob", key: "BLOB_READ_WRITE_TOKEN", target: ["production"], contentHint: { storeId: DEVELOPMENT_STORE_ID } },
        { id: "env_gateway", key: "AI_GATEWAY_API_KEY", target: ["production"], type: "sensitive" },
        ...acceptanceEnvironmentEntries(),
        ...gatewayBindingEnvironmentEntries(),
        { id: `env_${key.toLowerCase()}`, key, target: ["production"], type: "encrypted" },
      ] }),
    });
    await expect(api.inspect({ projectId: DEVELOPMENT_PROJECT_ID, teamId: TEAM_ID, storeId: DEVELOPMENT_STORE_ID, token: TOKEN }))
      .rejects.toThrow(/read-only preflight denied/i);
  });

  it.each([
    ["excludes BYOK spend", { includeByokInQuota: false }],
    ["is exhausted", { currentSpend: 1 }],
  ])("rejects a quota that %s", async (_name, quota) => {
    const api = subject.createReadOnlyVercelApi({
      fetchImpl: verifierApiFetch({ gatewayKeys: [developmentGatewayKey({ quota: { ...developmentGatewayKey().quota, ...quota } })] }),
    });
    await expect(api.inspect({ projectId: DEVELOPMENT_PROJECT_ID, teamId: TEAM_ID, storeId: DEVELOPMENT_STORE_ID, token: TOKEN }))
      .rejects.toThrow(/read-only preflight denied/i);
  });

  it("accepts the real nested private Blob store metadata", async () => {
    const api = subject.createReadOnlyVercelApi({
      fetchImpl: verifierApiFetch({ developmentStore: developmentStoreResponse() }),
    });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    })).resolves.toEqual(inspection());
  });

  it.each([
    ["malformed envelope", { id: DEVELOPMENT_STORE_ID }],
    ["public access", developmentStoreResponse({ access: "public" })],
    [
      "multiple connected projects",
      developmentStoreResponse({
        totalConnectedProjects: 2,
        projectsMetadata: [
          developmentStoreResponse().store.projectsMetadata[0],
          { ...developmentStoreResponse().store.projectsMetadata[0], projectId: "prj_other", name: "other" },
        ],
      }),
    ],
    [
      "wrong connected project",
      developmentStoreResponse({
        projectsMetadata: [{ ...developmentStoreResponse().store.projectsMetadata[0], projectId: "prj_other" }],
      }),
    ],
  ])("rejects unsafe nested Blob store metadata: %s", async (_name, developmentStore) => {
    const api = subject.createReadOnlyVercelApi({ fetchImpl: verifierApiFetch({ developmentStore }) });

    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    })).rejects.toThrow(/^Development Vercel read-only preflight denied by local safety policy$/);
  });

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

  it("uses only fixed GET requests, rechecks project settings, and decrypts only the declared non-secret controls", async () => {
    const fetchImpl = verifierApiFetch({ aliases: [] });

    const api = subject.createReadOnlyVercelApi({ fetchImpl });
    await expect(api.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: TEAM_ID,
      storeId: DEVELOPMENT_STORE_ID,
      token: TOKEN,
    })).resolves.toEqual(inspection());

    const requests = fetchImpl.mock.calls.map(([input, options]) => ({ url: new URL(input), options }));
    expect(requests).toHaveLength(17);
    expect(requests.every(({ options }) => options.method === "GET")).toBe(true);
    expect(requests.every(({ options }) => options.redirect === "error")).toBe(true);
    const decrypted = requests.filter(({ url }) => url.searchParams.get("decrypt") === "true");
    expect(decrypted).toHaveLength(10);
    expect(decrypted.some(({ url }) => url.pathname.endsWith("/env/env_gateway"))).toBe(false);
    expect(decrypted.some(({ url }) => url.pathname.endsWith("/env/env_gateway_key_id"))).toBe(true);
    expect(decrypted.some(({ url }) => url.pathname.endsWith("/env/env_gateway_key_partial"))).toBe(true);
    expect(requests.filter(({ url }) => url.pathname.endsWith("/domains")))
      .toHaveLength(2);
    expect(requests.filter(({ url }) => url.pathname.endsWith("/domains")).every(({ url }) => url.searchParams.get("limit") === "100"))
      .toBe(true);
    expect(requests.filter(({ url }) => url.pathname === "/v1/api-keys")).toHaveLength(1);
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
    const baseFetch = verifierApiFetch({ aliases: [] });
    const fetchImpl = vi.fn(async (input, options) => {
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
      return baseFetch(input, options);
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
