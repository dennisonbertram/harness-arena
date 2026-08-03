import { execFile, spawn as spawnProcess } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { verifyDevelopmentEnvironment } from "../ci/verify-development-environment.mjs";

const execFileAsync = promisify(execFile);

export const DEVELOPMENT_PROJECT_ID = "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA";
export const DEVELOPMENT_PROJECT_NAME = "harness-arena-development";
export const DEVELOPMENT_TEAM_ID = "team_cwyLpng8LCwWgINdiQ27hHYa";
export const DEVELOPMENT_SCOPE = "dennisons-projects";
export const LIVE_PROJECT_ID = "prj_f4ppu0xpO0LZeHOAH99RHotVbwyo";
export const PROTECTED_REMOTE_URL = "https://github.com/dennisonbertram/harness-arena.git";
export const PROTECTED_REMOTE_REF = "refs/heads/dev";
export const VERCEL_CLI_VERSION = "56.5.0";
export const MAX_OUTPUT_BYTES = 65_536;
export const OPERATION_TIMEOUT_MS = 30_000;
export const TERMINATION_GRACE_MS = 2_000;

const GIT_PATH = "/usr/bin/git";
const TAR_PATH = "/usr/bin/tar";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const VERCEL_CLI_MODULE = path.resolve(
  path.dirname(process.execPath),
  "../lib/node_modules/vercel/dist/vc.js",
);
const VERCEL_PACKAGE_JSON = path.resolve(VERCEL_CLI_MODULE, "../../package.json");
const ALLOWED_OPERATIONS = new Set(["deploy"]);
const LIVE_CALLBACK_ORIGINS = new Set([
  "https://harness-arena-psi.vercel.app",
  "https://harness-arena-dennisons-projects.vercel.app",
  "https://harness-arena-git-main-dennisons-projects.vercel.app",
]);

function denied(message = "Development Vercel operation denied by local safety policy") {
  return new Error(message);
}

function exactKeys(value, allowed) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === allowed.length
    && Object.keys(value).every((key) => allowed.includes(key));
}

function safeGitEnvironment() {
  return { PATH: "/usr/bin:/bin", LC_ALL: "C" };
}

async function git(cwd, args, { acceptExitCode = () => false } = {}) {
  try {
    const result = await execFileAsync(GIT_PATH, args, {
      cwd,
      encoding: "utf8",
      env: safeGitEnvironment(),
      timeout: 30_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
    });
    return { stdout: result.stdout, code: 0 };
  } catch (error) {
    if (typeof error?.code === "number" && acceptExitCode(error.code)) {
      return { stdout: error.stdout ?? "", code: error.code };
    }
    throw denied();
  }
}

async function defaultReadManifest(cwd) {
  const raw = await readFile(path.join(cwd, "config/development-environment.json"), "utf8");
  return JSON.parse(raw);
}

async function defaultReadProvenance(cwd, reviewedSha) {
  if (!SHA_PATTERN.test(reviewedSha)) throw denied();
  const { stdout: remoteUrl } = await git(cwd, ["remote", "get-url", "origin"]);
  if (remoteUrl.trim() !== PROTECTED_REMOTE_URL) throw denied();
  const [{ stdout: remoteLine }] = await Promise.all([
    git(cwd, ["ls-remote", "--exit-code", PROTECTED_REMOTE_URL, PROTECTED_REMOTE_REF]),
    git(cwd, ["cat-file", "-e", `${reviewedSha}^{commit}`]),
  ]);
  const fields = remoteLine.trim().split(/\s+/);
  if (fields.length !== 2) throw denied();
  const ancestor = await git(cwd, ["merge-base", "--is-ancestor", fields[0], reviewedSha], {
    acceptExitCode: (code) => code === 1,
  });
  return {
    reviewedSha,
    remote: {
      name: "origin",
      url: remoteUrl.trim(),
      ref: fields[1],
      sha: fields[0],
    },
    isAncestor: ancestor.code === 0,
  };
}

function validateProvenance(value, reviewedSha) {
  if (
    !SHA_PATTERN.test(reviewedSha)
    || !exactKeys(value, ["reviewedSha", "remote", "isAncestor"])
    || !exactKeys(value.remote, ["name", "url", "ref", "sha"])
    || value.reviewedSha !== reviewedSha
    || value.remote.name !== "origin"
    || value.remote.url !== PROTECTED_REMOTE_URL
    || value.remote.ref !== PROTECTED_REMOTE_REF
    || value.remote.sha !== reviewedSha
    || value.isAncestor !== true
  ) {
    throw denied();
  }
}

function parseTarOctal(buffer, start, length) {
  const raw = buffer.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(raw)) throw denied("Development archive denied by local safety policy");
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw denied("Development archive denied by local safety policy");
  return value;
}

function tarString(buffer, start, length) {
  const field = buffer.subarray(start, start + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function canonicalArchivePath(name, type) {
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0")) return false;
  const withoutDirectorySlash = type === "5" && name.endsWith("/") ? name.slice(0, -1) : name;
  if (!withoutDirectorySlash || (type !== "5" && name.endsWith("/"))) return false;
  const segments = withoutDirectorySlash.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Validate the tar stream before extraction. Git cannot store devices, but it
 * can store symlinks; accepting either would let a reviewed tree redirect the
 * upload extractor outside the immutable snapshot.
 */
export function validateTarArchive(buffer, { expectedSha } = {}) {
  const archiveError = () => denied("Development archive denied by local safety policy");
  if (!Buffer.isBuffer(buffer) || buffer.length < 1_024 || buffer.length % 512 !== 0) throw archiveError();
  const paths = [];
  const seen = new Set();
  let offset = 0;
  let zeroBlocks = 0;
  let globalHeaderSeen = false;
  let globalHeaderSha = null;

  while (offset < buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      offset += 512;
      if (zeroBlocks === 2) {
        if (!buffer.subarray(offset).every((byte) => byte === 0)) throw archiveError();
        if (expectedSha !== undefined && (!SHA_PATTERN.test(expectedSha) || globalHeaderSha !== expectedSha)) {
          throw archiveError();
        }
        return paths;
      }
      continue;
    }
    if (zeroBlocks !== 0) throw archiveError();

    const expectedChecksum = parseTarOctal(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (expectedChecksum !== actualChecksum) throw archiveError();

    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const archivePath = prefix ? `${prefix}/${name}` : name;
    const type = String.fromCharCode(header[156] || 48);
    const size = parseTarOctal(header, 124, 12);
    const bodyBlocks = Math.ceil(size / 512);
    const bodyEnd = offset + 512 + bodyBlocks * 512;
    if (bodyEnd > buffer.length) throw archiveError();
    if (type === "g") {
      const payload = buffer.subarray(offset + 512, offset + 512 + size).toString("utf8");
      const match = /^(\d+) comment=([0-9a-f]{40})\n$/.exec(payload);
      if (
        globalHeaderSeen
        || paths.length !== 0
        || prefix !== ""
        || name !== "pax_global_header"
        || !match
        || Number(match[1]) !== Buffer.byteLength(payload)
      ) {
        throw archiveError();
      }
      globalHeaderSeen = true;
      globalHeaderSha = match[2];
      offset = bodyEnd;
      continue;
    }
    if (!new Set(["0", "5"]).has(type) || !canonicalArchivePath(archivePath, type)) throw archiveError();
    if (type === "5" && size !== 0) throw archiveError();
    if (seen.has(archivePath)) throw archiveError();
    seen.add(archivePath);
    paths.push(archivePath);

    offset = bodyEnd;
  }
  throw archiveError();
}

async function defaultArchiveToFile({ cwd, reviewedSha, archivePath }) {
  await git(cwd, ["archive", "--format=tar", "--output", archivePath, reviewedSha]);
}

async function defaultExtractArchive({ archivePath, destination }) {
  try {
    await execFileAsync(TAR_PATH, ["-xf", archivePath, "-C", destination], {
      encoding: "utf8",
      env: safeGitEnvironment(),
      timeout: 30_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
    });
  } catch {
    throw denied("Development archive denied by local safety policy");
  }
}

export async function createReviewedSnapshot({
  cwd,
  reviewedSha,
  makeTempDirectory = () => mkdtemp(path.join(os.tmpdir(), "harness-arena-vercel-")),
  archiveToFile = defaultArchiveToFile,
  extractArchive = defaultExtractArchive,
  removeTemp = (target) => rm(target, { recursive: true, force: true }),
} = {}) {
  if (!SHA_PATTERN.test(reviewedSha) || typeof cwd !== "string" || !path.isAbsolute(cwd)) throw denied();
  const temp = await makeTempDirectory();
  const archivePath = path.join(temp, "reviewed.tar");
  const snapshotPath = path.join(temp, "snapshot");
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    await removeTemp(temp);
    cleaned = true;
  };
  try {
    await mkdir(snapshotPath, { mode: 0o700 });
    await archiveToFile({ cwd, reviewedSha, archivePath });
    validateTarArchive(await readFile(archivePath), { expectedSha: reviewedSha });
    await extractArchive({ archivePath, destination: snapshotPath });
    return { path: snapshotPath, cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch {
      throw denied("Development snapshot cleanup failed");
    }
    if (error instanceof Error && /Development archive denied/.test(error.message)) throw error;
    throw denied("Development archive denied by local safety policy");
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalGroup(groupId, signal) {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function waitForGroupExit(groupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!signalGroup(groupId, 0)) return true;
    await delay(20);
  }
  return !signalGroup(groupId, 0);
}

/** Spawn the CLI as its own process group and never return with descendants. */
export function spawnBounded(file, args, { cwd, env, timeoutMs, termGraceMs, maxOutputBytes }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(file, args, {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ stdout: "", stderr: "", code: 1, timedOut: false, reaped: true });
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let closed = false;
    let closeCode = 1;
    let spawnError = false;
    let closeResolve;
    const closePromise = new Promise((done) => { closeResolve = done; });
    const append = (current, chunk) => {
      const bytes = Buffer.from(chunk);
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      const accepted = bytes.subarray(0, remaining);
      outputBytes += accepted.length;
      return current + accepted.toString("utf8");
    };
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", () => {
      spawnError = true;
      if (!closed) {
        closed = true;
        closeResolve();
      }
    });
    child.once("close", (code) => {
      closeCode = code ?? 1;
      if (!closed) {
        closed = true;
        closeResolve();
      }
    });

    void (async () => {
      const completedNormally = await Promise.race([
        closePromise.then(() => true),
        delay(timeoutMs).then(() => false),
      ]);
      const groupId = child.pid;
      if (completedNormally) {
        let reaped = true;
        if (Number.isInteger(groupId) && signalGroup(groupId, 0)) {
          signalGroup(groupId, "SIGTERM");
          await delay(termGraceMs);
          signalGroup(groupId, "SIGKILL");
          reaped = await waitForGroupExit(groupId, termGraceMs);
        }
        resolve({ stdout, stderr, code: spawnError ? 1 : closeCode, timedOut: false, reaped });
        return;
      }

      if (Number.isInteger(groupId)) signalGroup(groupId, "SIGTERM");
      await delay(termGraceMs);
      if (Number.isInteger(groupId)) signalGroup(groupId, "SIGKILL");
      const childClosed = await Promise.race([
        closePromise.then(() => true),
        delay(termGraceMs).then(() => false),
      ]);
      const reaped = childClosed
        && (!Number.isInteger(groupId) || await waitForGroupExit(groupId, termGraceMs));
      resolve({ stdout, stderr, code: closeCode, timedOut: true, reaped });
    })();
  });
}

async function defaultVerifyCliModule() {
  try {
    const [moduleStat, moduleRealPath, packageJson] = await Promise.all([
      lstat(VERCEL_CLI_MODULE),
      realpath(VERCEL_CLI_MODULE),
      readFile(VERCEL_PACKAGE_JSON, "utf8").then(JSON.parse),
    ]);
    const expectedRoot = await realpath(path.dirname(VERCEL_PACKAGE_JSON));
    if (
      !moduleStat.isFile()
      || packageJson?.version !== VERCEL_CLI_VERSION
      || !moduleRealPath.startsWith(`${expectedRoot}${path.sep}`)
    ) {
      throw denied();
    }
  } catch {
    throw denied();
  }
}

function requestUrl(pathname, query = {}) {
  const url = new URL(pathname, "https://api.vercel.com");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

async function requestJson(fetchImpl, token, url) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
  });
  if (!response?.ok) throw denied();
  return response.json();
}

export function createReadOnlyVercelApi({ fetchImpl = globalThis.fetch } = {}) {
  return {
    async preflight({ projectId, teamId, storeId, token }) {
      try {
        const [project, environments, store] = await Promise.all([
          requestJson(fetchImpl, token, requestUrl(`/v9/projects/${encodeURIComponent(projectId)}`, { teamId })),
          requestJson(fetchImpl, token, requestUrl(`/v10/projects/${encodeURIComponent(projectId)}/env`, { teamId })),
          requestJson(fetchImpl, token, requestUrl(`/v1/storage/stores/${encodeURIComponent(storeId)}`, { teamId })),
        ]);
        const callbackEntries = environments?.envs?.filter(
          (entry) => entry?.key === "CALLBACK_BASE" && Array.isArray(entry.target) && entry.target.includes("preview"),
        );
        if (callbackEntries?.length !== 1 || typeof callbackEntries[0].id !== "string") throw denied();
        const callback = await requestJson(
          fetchImpl,
          token,
          requestUrl(
            `/v10/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(callbackEntries[0].id)}`,
            { teamId, decrypt: "true" },
          ),
        );
        const projectConnections = Array.isArray(store?.projects) ? store.projects : [];
        const connection = projectConnections.find((item) => item?.projectId === projectId);
        return {
          project: { id: project?.id, ownerId: project?.accountId, name: project?.name },
          environment: { callbackBase: callback?.value },
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
    async deployment({ url, teamId, token }) {
      try {
        const hostname = new URL(url).hostname;
        const value = await requestJson(
          fetchImpl,
          token,
          requestUrl(`/v13/deployments/${encodeURIComponent(hostname)}`, { teamId }),
        );
        return {
          id: value?.id,
          url: value?.url,
          projectId: value?.projectId,
          ownerId: value?.ownerId,
          target: value?.target ?? null,
          meta: { reviewedSha: value?.meta?.reviewedSha },
        };
      } catch {
        throw denied("Development Vercel postflight denied by local safety policy");
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
    || !Array.isArray(manifest.live.aliases)
    || !Array.isArray(manifest.live.storeIds)
  ) {
    throw denied();
  }
}

function validatePreflight(actual, manifest) {
  if (
    !exactKeys(actual, ["project", "environment", "store"])
    || !exactKeys(actual.project, ["id", "ownerId", "name"])
    || !exactKeys(actual.environment, ["callbackBase"])
    || !exactKeys(actual.store, ["id", "ownerId", "projectId", "type"])
    || actual.project.id !== DEVELOPMENT_PROJECT_ID
    || actual.project.ownerId !== DEVELOPMENT_TEAM_ID
    || actual.project.name !== DEVELOPMENT_PROJECT_NAME
    || actual.environment.callbackBase !== manifest.callbackOrigin
    || LIVE_CALLBACK_ORIGINS.has(actual.environment.callbackBase)
    || manifest.live.aliases.includes(new URL(actual.environment.callbackBase).hostname)
    || actual.store.id !== manifest.store.id
    || actual.store.ownerId !== DEVELOPMENT_TEAM_ID
    || actual.store.projectId !== DEVELOPMENT_PROJECT_ID
    || actual.store.type !== "blob"
    || manifest.live.storeIds.includes(actual.store.id)
  ) {
    throw denied();
  }
}

function parseDeploymentUrl(stdout) {
  if (typeof stdout !== "string") throw denied("Development Vercel operation failed");
  const tokens = stdout.trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) throw denied("Development Vercel operation failed");
  let url;
  try {
    url = new URL(tokens[0]);
  } catch {
    throw denied("Development Vercel operation failed");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.pathname !== "/"
    || url.search
    || url.hash
    || !url.hostname.endsWith(".vercel.app")
    || LIVE_CALLBACK_ORIGINS.has(url.origin)
  ) {
    throw denied("Development Vercel operation failed");
  }
  return url.origin;
}

function validatePostflight(actual, deploymentUrl, reviewedSha) {
  const expectedHostname = new URL(deploymentUrl).hostname;
  if (
    !exactKeys(actual, ["id", "url", "projectId", "ownerId", "target", "meta"])
    || !exactKeys(actual.meta, ["reviewedSha"])
    || typeof actual.id !== "string"
    || !actual.id.startsWith("dpl_")
    || actual.url !== expectedHostname
    || actual.projectId !== DEVELOPMENT_PROJECT_ID
    || actual.ownerId !== DEVELOPMENT_TEAM_ID
    || actual.target !== null
    || actual.meta.reviewedSha !== reviewedSha
  ) {
    throw denied("Development Vercel postflight denied by local safety policy");
  }
}

/**
 * The sole write path: deploy one exact reviewed origin/dev commit as a
 * built-in Preview to the fixed Development project.
 */
export async function runDevelopmentVercelOperation({
  operation,
  reviewedSha,
  token,
  cwd = process.cwd(),
  readManifest = defaultReadManifest,
  readProvenance = defaultReadProvenance,
  createSnapshot = createReviewedSnapshot,
  readOnlyApi = createReadOnlyVercelApi(),
  verifyCliModule = defaultVerifyCliModule,
  spawn = spawnBounded,
} = {}) {
  if (!ALLOWED_OPERATIONS.has(operation) || !SHA_PATTERN.test(reviewedSha) || typeof token !== "string" || !token) {
    throw denied();
  }

  let manifest;
  let provenance;
  let actualPreflight;
  try {
    manifest = await readManifest(cwd);
    validateManifest(manifest);
    [provenance, actualPreflight] = await Promise.all([
      readProvenance(cwd, reviewedSha),
      readOnlyApi.preflight({
        projectId: DEVELOPMENT_PROJECT_ID,
        teamId: DEVELOPMENT_TEAM_ID,
        storeId: manifest.store.id,
        token,
      }),
      verifyCliModule(),
    ]);
    validateProvenance(provenance, reviewedSha);
    validatePreflight(actualPreflight, manifest);
  } catch {
    throw denied();
  }

  let snapshot;
  try {
    snapshot = await createSnapshot({ cwd, reviewedSha });
    if (
      typeof snapshot?.path !== "string"
      || !path.isAbsolute(snapshot.path)
      || typeof snapshot.cleanup !== "function"
    ) {
      throw denied();
    }
    const relativeToCwd = path.relative(path.resolve(cwd), path.resolve(snapshot.path));
    if (relativeToCwd === "" || (!relativeToCwd.startsWith("..") && !path.isAbsolute(relativeToCwd))) throw denied();

    let result;
    try {
      result = await spawn(process.execPath, [
        VERCEL_CLI_MODULE,
        "deploy",
        snapshot.path,
        "--yes",
        "--no-wait",
        "--scope",
        DEVELOPMENT_SCOPE,
        "--meta",
        `reviewedSha=${reviewedSha}`,
      ], {
        cwd: snapshot.path,
        env: {
          VERCEL_ORG_ID: DEVELOPMENT_TEAM_ID,
          VERCEL_PROJECT_ID: DEVELOPMENT_PROJECT_ID,
          VERCEL_TOKEN: token,
        },
        timeoutMs: OPERATION_TIMEOUT_MS,
        termGraceMs: TERMINATION_GRACE_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
    } catch {
      throw denied("Development Vercel operation failed");
    }
    if (!result || result.code !== 0 || result.timedOut || result.reaped !== true) {
      throw denied("Development Vercel operation failed");
    }

    const deploymentUrl = parseDeploymentUrl(result.stdout);
    let actualDeployment;
    try {
      actualDeployment = await readOnlyApi.deployment({
        url: deploymentUrl,
        teamId: DEVELOPMENT_TEAM_ID,
        token,
      });
    } catch {
      throw denied("Development Vercel postflight denied by local safety policy");
    }
    validatePostflight(actualDeployment, deploymentUrl, reviewedSha);
    return {
      deploymentId: actualDeployment.id,
      reviewedSha,
      url: deploymentUrl,
    };
  } finally {
    if (snapshot?.cleanup) {
      try {
        await snapshot.cleanup();
      } catch {
        throw denied("Development snapshot cleanup failed");
      }
    }
  }
}

async function main() {
  if (process.argv.length !== 4) throw denied();
  const result = await runDevelopmentVercelOperation({
    operation: process.argv[2],
    reviewedSha: process.argv[3],
    token: process.env.VERCEL_TOKEN,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
