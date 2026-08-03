import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { verifyDevelopmentEnvironment } from "../ci/verify-development-environment.mjs";

const execFileAsync = promisify(execFile);

export const DEVELOPMENT_PROJECT_ID = "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA";
export const DEVELOPMENT_PROJECT_NAME = "harness-arena-development";
export const DEVELOPMENT_TEAM_ID = "team_cwyLpng8LCwWgINdiQ27hHYa";
export const LIVE_PROJECT_ID = "prj_f4ppu0xpO0LZeHOAH99RHotVbwyo";
export const PROTECTED_REMOTE_URL = "https://github.com/dennisonbertram/harness-arena.git";
export const PROTECTED_REMOTE_REF = "refs/heads/dev";

const GIT_PATH = "/usr/bin/git";
const GIT_NETWORK_CWD = "/";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_GIT_OUTPUT_BYTES = 4_096;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1_024;
const EXPECTED_GIT = Object.freeze({
  type: "github",
  org: "dennisonbertram",
  repo: "harness-arena",
  productionBranch: "dev",
});

function denied() {
  return new Error("Development Vercel read-only preflight denied by local safety policy");
}

function exactKeys(value, allowed) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === allowed.length
    && Object.keys(value).every((key) => allowed.includes(key));
}

function safeGitEnvironment() {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    HOME: "/dev/null",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
  };
}

function pathIsOutside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * Resolve the protected ref without consulting repository, user, or system Git
 * configuration. Running outside the repository prevents local insteadOf and
 * include rules from participating; --no-replace-objects also pins raw refs.
 */
export async function readTrustedRemoteDevSha({
  cwd = process.cwd(),
  execFileImpl = execFileAsync,
  networkCwd = GIT_NETWORK_CWD,
} = {}) {
  if (
    typeof cwd !== "string"
    || !path.isAbsolute(cwd)
    || typeof networkCwd !== "string"
    || !path.isAbsolute(networkCwd)
    || !pathIsOutside(networkCwd, cwd)
  ) {
    throw denied();
  }

  try {
    const result = await execFileImpl(GIT_PATH, [
      "--no-replace-objects",
      "ls-remote",
      "--exit-code",
      PROTECTED_REMOTE_URL,
      PROTECTED_REMOTE_REF,
    ], {
      cwd: networkCwd,
      encoding: "utf8",
      env: safeGitEnvironment(),
      timeout: 10_000,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      shell: false,
    });
    const match = /^([0-9a-f]{40})\trefs\/heads\/dev\n?$/.exec(result?.stdout ?? "");
    if (!match) throw denied();
    return match[1];
  } catch {
    throw denied();
  }
}

async function defaultReadManifest(cwd) {
  return JSON.parse(await readFile(path.join(cwd, "config/development-environment.json"), "utf8"));
}

function requestUrl(pathname, query = {}) {
  const url = new URL(pathname, "https://api.vercel.com");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

async function readBoundedJson(response, maxBodyBytes) {
  const reader = response?.body?.getReader?.();
  if (!reader) throw denied();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBodyBytes) {
      await reader.cancel().catch(() => {});
      throw denied();
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

async function requestJson(fetchImpl, token, url, { timeoutMs, maxBodyBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) throw denied();
    return await readBoundedJson(response, maxBodyBytes);
  } catch {
    throw denied();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeProject(value) {
  return {
    id: value?.id,
    ownerId: value?.accountId,
    name: value?.name,
    git: {
      type: value?.link?.type,
      org: value?.link?.org,
      repo: value?.link?.repo,
      productionBranch: value?.link?.productionBranch,
    },
  };
}

function normalizeProductionDomains(value, projectId) {
  if (
    !exactKeys(value, ["domains", "pagination"])
    || !Array.isArray(value.domains)
    || !exactKeys(value.pagination, ["count", "next", "prev"])
    || !Number.isSafeInteger(value.pagination.count)
    || value.pagination.count !== value.domains.length
    || value.pagination.next !== null
    || (value.pagination.prev !== null && (!Number.isSafeInteger(value.pagination.prev) || value.pagination.prev < 0))
  ) throw denied();
  const domains = value.domains.map((domain) => {
    const allowed = [
      "name",
      "apexName",
      "projectId",
      "verified",
      "redirect",
      "redirectStatusCode",
      "gitBranch",
      "customEnvironmentId",
      "updatedAt",
      "createdAt",
      "verification",
    ];
    if (
      !domain
      || typeof domain !== "object"
      || Array.isArray(domain)
      || Object.keys(domain).some((key) => !allowed.includes(key))
      || typeof domain.name !== "string"
      || !domain.name
      || typeof domain.apexName !== "string"
      || !domain.apexName
      || domain.projectId !== projectId
      || domain.verified !== true
      || (domain.redirect !== undefined && domain.redirect !== null)
      || (domain.redirectStatusCode !== undefined && domain.redirectStatusCode !== null)
      || (domain.gitBranch !== undefined && domain.gitBranch !== null)
      || (domain.customEnvironmentId !== undefined && domain.customEnvironmentId !== null)
    ) {
      throw denied();
    }
    return {
      domain: domain.name,
      environment: "production",
      target: "PRODUCTION",
      redirect: undefined,
    };
  });
  domains.sort((left, right) => left.domain.localeCompare(right.domain));
  if (domains.some((domain, index) => index > 0 && domain.domain === domains[index - 1].domain)) throw denied();
  return {
    aliases: domains,
    pagination: {
      count: value.pagination.count,
      next: value.pagination.next,
      prev: value.pagination.prev,
    },
  };
}

function sortedUniqueStrings(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw denied();
  const normalized = [...value].sort();
  if (normalized.some((item, index) => index > 0 && item === normalized[index - 1])) throw denied();
  return normalized;
}

function normalizeLiveInventory(value) {
  if (!exactKeys(value, ["projectId", "aliases", "storeIds"]) || typeof value.projectId !== "string" || !value.projectId) {
    throw denied();
  }
  const aliases = sortedUniqueStrings(value.aliases);
  return {
    projectId: value.projectId,
    aliases,
    pinnedAlias: value.aliases[0],
    storeIds: sortedUniqueStrings(value.storeIds),
  };
}

function normalizeLiveDeployment(value, live) {
  if (
    !value
    || typeof value !== "object"
    || value.projectId !== live.projectId
    || value.target !== "production"
    || value.readyState !== "READY"
  ) throw denied();
  return sortedUniqueStrings(value.alias);
}

function normalizeLiveStoreIds(value) {
  const allowedTargets = new Set(["production", "preview", "development"]);
  if (
    !exactKeys(value, ["envs", "hiddenProductionEnvCount"])
    || !Array.isArray(value.envs)
    || !Number.isSafeInteger(value.hiddenProductionEnvCount)
    || value.hiddenProductionEnvCount !== 0
  ) throw denied();
  const storeIds = [];
  for (const entry of value.envs) {
    const storeId = entry?.contentHint?.storeId;
    if (storeId === undefined) continue;
    if (
      typeof storeId !== "string"
      || !storeId
      || !Array.isArray(entry.target)
      || entry.target.length === 0
      || entry.target.some((target) => typeof target !== "string" || !allowedTargets.has(target))
      || new Set(entry.target).size !== entry.target.length
    ) throw denied();
    if (entry.target.includes("production")) storeIds.push(storeId);
  }
  return sortedUniqueStrings(storeIds);
}

function identical(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A fixed-endpoint, GET-only adapter. It never reads credential values. */
export function createReadOnlyVercelApi({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  if (
    typeof fetchImpl !== "function"
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || !Number.isSafeInteger(maxBodyBytes)
    || maxBodyBytes <= 0
  ) {
    throw denied();
  }
  const get = (token, url) => requestJson(fetchImpl, token, url, { timeoutMs, maxBodyBytes });

  return {
    async inspect({ projectId, teamId, storeId, token, live }) {
      if (
        projectId !== DEVELOPMENT_PROJECT_ID
        || teamId !== DEVELOPMENT_TEAM_ID
        || typeof storeId !== "string"
        || !storeId
        || typeof token !== "string"
        || !token
      ) {
        throw denied();
      }
      try {
        const liveInventory = live === undefined ? null : normalizeLiveInventory(live);
        const projectUrl = requestUrl(`/v9/projects/${encodeURIComponent(projectId)}`, { teamId });
        const projectBefore = normalizeProject(await get(token, projectUrl));
        const domainsUrl = requestUrl(`/v9/projects/${encodeURIComponent(projectId)}/domains`, { teamId, limit: "100" });
        const domainInventoryBefore = normalizeProductionDomains(await get(token, domainsUrl), projectId);
        const liveDeploymentUrl = liveInventory === null ? null : requestUrl(
          `/v13/deployments/${encodeURIComponent(liveInventory.pinnedAlias)}`,
          { teamId, withGitRepoInfo: "true" },
        );
        const liveEnvironmentUrl = liveInventory === null ? null : requestUrl(
          `/v10/projects/${encodeURIComponent(liveInventory.projectId)}/env`,
          { teamId },
        );
        const liveBefore = liveInventory === null ? null : {
          aliases: normalizeLiveDeployment(await get(token, liveDeploymentUrl), liveInventory),
          storeIds: normalizeLiveStoreIds(await get(token, liveEnvironmentUrl)),
        };
        if (liveBefore !== null && !identical(liveBefore, { aliases: liveInventory.aliases, storeIds: liveInventory.storeIds })) {
          throw denied();
        }
        const environments = await get(
          token,
          requestUrl(`/v10/projects/${encodeURIComponent(projectId)}/env`, { teamId }),
        );
        const entries = environments?.envs;
        if (!Array.isArray(entries)) throw denied();
        const callbackEntries = entries.filter((entry) =>
          entry?.key === "CALLBACK_BASE"
          && Array.isArray(entry.target)
          && entry.target.length === 1
          && entry.target[0] === "production",
        );
        if (callbackEntries.length !== 1 || typeof callbackEntries[0].id !== "string") throw denied();
        const blobTokenEntries = entries.filter((entry) => entry?.key === "BLOB_READ_WRITE_TOKEN");
        if (
          blobTokenEntries.length !== 1
          || !Array.isArray(blobTokenEntries[0].target)
          || blobTokenEntries[0].target.length !== 1
          || blobTokenEntries[0].target[0] !== "production"
          || blobTokenEntries[0]?.contentHint?.storeId !== storeId
        ) {
          throw denied();
        }
        const callback = await get(
          token,
          requestUrl(
            `/v10/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(callbackEntries[0].id)}`,
            { teamId, decrypt: "true" },
          ),
        );
        const store = await get(
          token,
          requestUrl(`/v1/storage/stores/${encodeURIComponent(storeId)}`, { teamId }),
        );
        const projectAfter = normalizeProject(await get(token, projectUrl));
        const domainInventoryAfter = normalizeProductionDomains(await get(token, domainsUrl), projectId);
        const liveAfter = liveInventory === null ? null : {
          aliases: normalizeLiveDeployment(await get(token, liveDeploymentUrl), liveInventory),
          storeIds: normalizeLiveStoreIds(await get(token, liveEnvironmentUrl)),
        };
        if (
          !identical(projectBefore, projectAfter)
          || !identical(domainInventoryBefore, domainInventoryAfter)
          || !identical(liveBefore, liveAfter)
        ) throw denied();
        const projectConnections = Array.isArray(store?.projects) ? store.projects : [];
        const connection = projectConnections.find((item) => item?.projectId === projectId);
        const environmentStoreIds = [...new Set(entries.flatMap((entry) => {
          const id = entry?.contentHint?.storeId;
          return typeof id === "string" && id ? [id] : [];
        }))];
        return {
          project: { ...projectAfter, aliases: domainInventoryAfter.aliases },
          environment: {
            callbackBase: callback?.value,
            networkModeConfigured: entries.some((entry) => entry?.key === "RUNNER_NETWORK_MODE"),
            blobStoreId: blobTokenEntries[0].contentHint.storeId,
            storeIds: environmentStoreIds,
          },
          store: {
            id: store?.id,
            ownerId: store?.ownerId,
            projectId: connection?.projectId,
            type: store?.type,
          },
        };
      } catch {
        throw denied();
      }
    },
  };
}

function validateManifest(manifest) {
  const verification = verifyDevelopmentEnvironment({ development: manifest, live: manifest?.live });
  if (
    !verification.ok
    || manifest.vercelProject.id !== DEVELOPMENT_PROJECT_ID
    || manifest.vercelProject.name !== DEVELOPMENT_PROJECT_NAME
    || manifest.live.projectId !== LIVE_PROJECT_ID
    || manifest.git.provider !== "github"
    || manifest.git.repository !== `${EXPECTED_GIT.org}/${EXPECTED_GIT.repo}`
    || manifest.git.productionBranch !== EXPECTED_GIT.productionBranch
  ) {
    throw denied();
  }
}

function validateInspection(actual, manifest) {
  if (
    !exactKeys(actual, ["project", "environment", "store"])
    || !exactKeys(actual.project, ["id", "ownerId", "name", "git", "aliases"])
    || !exactKeys(actual.project.git, ["type", "org", "repo", "productionBranch"])
    || !exactKeys(actual.environment, ["callbackBase", "networkModeConfigured", "blobStoreId", "storeIds"])
    || !exactKeys(actual.store, ["id", "ownerId", "projectId", "type"])
    || actual.project.id !== DEVELOPMENT_PROJECT_ID
    || actual.project.id === LIVE_PROJECT_ID
    || actual.project.ownerId !== DEVELOPMENT_TEAM_ID
    || actual.project.name !== DEVELOPMENT_PROJECT_NAME
    || Object.entries(EXPECTED_GIT).some(([key, value]) => actual.project.git[key] !== value)
    || !Array.isArray(actual.project.aliases)
    || actual.project.aliases.length === 0
    || actual.project.aliases.some((alias) =>
      !exactKeys(alias, ["domain", "environment", "target", "redirect"])
      || typeof alias.domain !== "string"
      || !alias.domain
      || alias.environment !== "production"
      || alias.target !== "PRODUCTION"
      || (alias.redirect !== undefined && alias.redirect !== null)
    )
    || !actual.project.aliases.some((alias) => alias.domain === manifest.host)
    || actual.project.aliases.some((alias) => manifest.live.aliases.includes(alias.domain))
    || actual.environment.callbackBase !== manifest.callbackOrigin
    || manifest.live.aliases.includes(new URL(actual.environment.callbackBase).hostname)
    || actual.environment.networkModeConfigured !== false
    || actual.environment.blobStoreId !== manifest.store.id
    || !Array.isArray(actual.environment.storeIds)
    || actual.environment.storeIds.some((id) => typeof id !== "string" || !id)
    || !actual.environment.storeIds.includes(manifest.store.id)
    || actual.environment.storeIds.some((id) => manifest.live.storeIds.includes(id))
    || actual.store.id !== manifest.store.id
    || manifest.live.storeIds.includes(actual.store.id)
    || actual.store.ownerId !== DEVELOPMENT_TEAM_ID
    || actual.store.projectId !== DEVELOPMENT_PROJECT_ID
    || actual.store.type !== "blob"
  ) {
    throw denied();
  }
}

function isVercelContext(env) {
  return env?.VERCEL === "1" || (typeof env?.VERCEL_ENV === "string" && env.VERCEL_ENV !== "");
}

export async function verifyDevelopmentPreflight({
  operation = "verify",
  reviewedSha,
  token,
  cwd = process.cwd(),
  inheritedEnv = process.env,
  readManifest = defaultReadManifest,
  readRemoteSha = readTrustedRemoteDevSha,
  readOnlyApi = createReadOnlyVercelApi(),
} = {}) {
  if (
    operation !== "verify"
    || !SHA_PATTERN.test(reviewedSha)
    || typeof token !== "string"
    || !token
    || typeof cwd !== "string"
    || !path.isAbsolute(cwd)
    || (isVercelContext(inheritedEnv) && inheritedEnv.RUNNER_NETWORK_MODE === "allow-all")
  ) {
    throw denied();
  }

  try {
    const manifest = await readManifest(cwd);
    validateManifest(manifest);
    const remoteBefore = await readRemoteSha({ cwd });
    if (remoteBefore !== reviewedSha) throw denied();
    const actual = await readOnlyApi.inspect({
      projectId: DEVELOPMENT_PROJECT_ID,
      teamId: DEVELOPMENT_TEAM_ID,
      storeId: manifest.store.id,
      token,
      live: manifest.live,
    });
    validateInspection(actual, manifest);
    const remoteAfter = await readRemoteSha({ cwd });
    if (remoteAfter !== reviewedSha) throw denied();
    return {
      ok: true,
      reviewedSha,
      remote: { url: PROTECTED_REMOTE_URL, ref: PROTECTED_REMOTE_REF, sha: reviewedSha },
      project: {
        id: DEVELOPMENT_PROJECT_ID,
        name: DEVELOPMENT_PROJECT_NAME,
        productionBranch: EXPECTED_GIT.productionBranch,
      },
    };
  } catch {
    throw denied();
  }
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "verify") throw denied();
  const result = await verifyDevelopmentPreflight({
    operation: process.argv[2],
    reviewedSha: process.argv[3],
    token: process.env.VERCEL_TOKEN,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write(`${denied().message}\n`);
    process.exitCode = 1;
  });
}
