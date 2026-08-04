import { access, open, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  acquireInitLock,
  assertNodeVersion,
  assertSafeStateDirectory,
  chooseAvailablePort,
  detachOwnedSupervisor,
  failTimedOutStart,
  isProcessAlive,
  inspectSafeStateDirectory,
  probeInstance,
  probeLocalInstance,
  readInstanceMetadata,
  readCurrentBranch,
  readManagedLocalConfig,
  removeInstanceMetadataIfOwned,
  resetLocalData,
  safeChildEnv,
  spawnSupervisedProcess,
  terminateOwnedSupervisor,
  waitForOwnershipHandshake,
} from "./init-lib.mjs";

const worktree = resolve(process.cwd());
const args = new Set(process.argv.slice(2));
const validArgs = new Set(["--check", "--no-install", "--reset", "--smoke", "--real-sandbox-smoke"]);
const json = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const exists = async (path) => access(path).then(() => true).catch(() => false);
const prerequisiteTimeoutMs = positiveTimeout(process.env.HARNESS_INIT_PREREQUISITE_TIMEOUT_MS, 120_000);
const shutdownHandlers = new Map();
const shutdownController = new AbortController();
let activePrerequisite;
let activeServer;
let shutdownSignal;

for (const signal of ["SIGINT", "SIGTERM"]) {
  const handler = () => requestShutdown(signal);
  shutdownHandlers.set(signal, handler);
  process.on(signal, handler);
}

try {
  await main();
} catch (error) {
  if (!shutdownSignal) throw error;
}
if (shutdownSignal) await exitForSignal();

async function main() {
  if ([...args].some((arg) => !validArgs.has(arg))
    || (args.has("--reset") && args.size > 1)
    || (args.has("--real-sandbox-smoke") && args.size > 1)
    || (args.has("--check") && args.has("--smoke"))) {
    throw new Error("usage: ./scripts/init.sh [--check] [--no-install] [--smoke] [--reset] [--real-sandbox-smoke]");
  }
  assertNodeVersion(process.versions.node);

  if (args.has("--real-sandbox-smoke")) {
    const branch = await readCurrentBranch(worktree);
    const { Sandbox } = await import("@vercel/sandbox");
    const { runRealSandboxSmoke } = await import("./real-sandbox-smoke-lib.mjs");
    json(await runRealSandboxSmoke({ env: { ...process.env, HARNESS_GIT_BRANCH: branch }, create: (options) => Sandbox.create(options) }));
    return;
  }

  if (args.has("--reset")) {
    const result = await resetLocalData(worktree);
    json({ ok: true, mode: "reset", ...result });
    return;
  }

  if (args.has("--check")) await checkOnly();
  else await initialize(await assertSafeStateDirectory(worktree));
}

async function checkOnly() {
  const inspected = await inspectSafeStateDirectory(worktree);
  const pnpm = await commandExists("pnpm");
  if (!pnpm) throw new Error("pnpm is required and was not found on PATH");
  const observed = inspected.exists ? await inspectPidForCheck(inspected.state) : { state: "absent" };
  if (observed.state === "live") {
    if (observed.legacy) throw new Error(`legacy PID metadata points to live process ${observed.pid}; stop it before restarting`);
    const owned = await probeLocalInstance(observed.metadata, 1_000, shutdownController.signal);
    if (!owned) throw new Error(`local PID ${observed.pid} is alive but read-only ownership did not match; refusing a second server`);
    json(instanceOutput("existing", observed.metadata, { stale_pid_recovered: false, stale_pid_detected: false }, inspected.state));
    return;
  }
  const port = await chooseAvailablePort(worktree);
  json({
    ok: true,
    mode: "check",
    port,
    storage: join(inspected.state, "local-data"),
    stale_pid_detected: observed.state === "stale",
  });
}

async function inspectPidForCheck(state) {
  const pidPath = join(state, "init.pid");
  let raw;
  try { raw = await readFile(pidPath, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return { state: "absent" }; throw error; }
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`unrecognized PID metadata at ${pidPath}; --check will not modify it`); }
  if (Number.isSafeInteger(value) && value > 0) return { state: isProcessAlive(value) ? "live" : "stale", pid: value, legacy: true };
  if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.port) || value.port <= 0 || typeof value.nonce !== "string" || !value.nonce) {
    throw new Error(`unrecognized PID metadata at ${pidPath}; --check will not modify it`);
  }
  return { state: isProcessAlive(value.pid) ? "live" : "stale", pid: value.pid, legacy: false, metadata: value };
}

async function initialize(state) {
 const pidPath = join(state, "init.pid");
 const lockPath = join(state, "init.lock");
 const logPath = join(state, "init.log");
 await phaseBarrier("lock_wait");
 const releaseLock = await acquireInitLock(lockPath, { signal: shutdownController.signal });
 let serverOwned;
 let serverDetached = false;
 try {
  shutdownController.signal.throwIfAborted();
  const pnpm = await commandExists("pnpm");
  if (!pnpm) throw new Error("pnpm is required and was not found on PATH");

  let stalePidRecovered = false;
  const metadata = await readInstanceMetadata(state);
  if (metadata) {
    if (isProcessAlive(metadata.pid)) {
      const ready = await probeInstance(metadata, 1_000, shutdownController.signal);
      if (!ready) throw new Error(`local PID ${metadata.pid} is alive but readiness ownership did not match; refusing a second server`);
      const smoke = args.has("--smoke") ? await runSmoke(metadata, state) : undefined;
      json(instanceOutput("existing", metadata, { stale_pid_recovered: false, ...(smoke ? { smoke } : {}) }, state));
      return;
    }
    await rm(pidPath, { force: true });
    stalePidRecovered = true;
  } else if (await exists(pidPath)) {
    const legacyPid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
    if (isProcessAlive(legacyPid)) throw new Error(`legacy PID metadata points to live process ${legacyPid}; stop it before restarting`);
    await rm(pidPath, { force: true });
    stalePidRecovered = true;
  }

  const port = await chooseAvailablePort(worktree);

  const localConfig = await readManagedLocalConfig(worktree);
  const gitBranch = await readCurrentBranch(worktree);
  const guardedLocalConfig = { ...localConfig, HARNESS_GIT_BRANCH: gitBranch };
  const installEnv = await safeChildEnv(worktree, process.env, guardedLocalConfig);
  await run(process.execPath, ["scripts/check-task-image-lock.mjs"], { cwd: worktree, env: installEnv, stdio: "inherit" }, "task image lock readiness");
  if (!args.has("--no-install")) await run("pnpm", ["install", "--frozen-lockfile"], { cwd: worktree, env: installEnv, stdio: "inherit" }, "pnpm install");

  await run(process.execPath, ["scripts/seed-local.mjs"], { cwd: worktree, env: installEnv, stdio: "inherit" }, "local seed");
  const nextBin = join(worktree, "node_modules", "next", "dist", "bin", "next");
  if (!(await exists(nextBin))) throw new Error("Next.js is not installed; rerun without --no-install");
  await phaseBarrier("pre_server_spawn");
  shutdownController.signal.throwIfAborted();

  const nonce = randomUUID();
  const serverEnv = await safeChildEnv(worktree, process.env, { ...guardedLocalConfig, LOCAL_INSTANCE_NONCE: nonce });
  serverEnv.HARNESS_INIT_STATE = state;
  serverEnv.LOCAL_INSTANCE_PORT = String(port);
  const logHandle = await open(logPath, "a", 0o600);
  try {
  serverOwned = await spawnSupervisedProcess(process.execPath, ["scripts/local-next-wrapper.mjs", nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: worktree,
      env: serverEnv,
      stdio: ["ignore", logHandle.fd, logHandle.fd, "pipe"],
    }, { signal: shutdownController.signal });
  } finally { await logHandle.close(); }
  activeServer = serverOwned;
  const child = serverOwned.child;
  const instance = { pid: serverOwned.supervisorPid, nonce, port, started_at: new Date().toISOString() };
  try {
    await phaseBarrier("ownership_handshake");
    await waitForOwnershipHandshake(child, instance, { signal: shutdownController.signal });
  } catch (error) {
    await terminateOwnedSupervisor(serverOwned);
    await removeInstanceMetadataIfOwned(state, instance);
    throw error;
  }
  child.stdio[3]?.destroy();

  const timeoutMs = Number.parseInt(process.env.HARNESS_INIT_READY_TIMEOUT_MS ?? "30000", 10);
  const deadline = Date.now() + (Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000);
  await phaseBarrier("readiness_poll");
  while (Date.now() < deadline) {
    shutdownController.signal.throwIfAborted();
    if (await probeInstance(instance, 500, shutdownController.signal)) {
      await rm(join(state, "init-failure.json"), { force: true });
      await phaseBarrier("server_lifecycle");
      shutdownController.signal.throwIfAborted();
      const smoke = args.has("--smoke") ? await runSmoke(instance, state) : undefined;
      if (!await detachOwnedSupervisor(serverOwned, {
        signal: shutdownController.signal,
        beforeDisconnect: () => phaseBarrier("durable_detach"),
      })) throw new Error("local supervisor exited before durable detach");
      shutdownController.signal.throwIfAborted();
      serverDetached = true;
      activeServer = undefined;
      json(instanceOutput("start", instance, { stale_pid_recovered: stalePidRecovered, ...(smoke ? { smoke } : {}) }, state));
      return;
    }
    if (!isProcessAlive(instance.pid)) break;
    await abortableDelay(100, shutdownController.signal);
  }
  await failTimedOutStart({ worktree, owned: serverOwned, pid: instance.pid, nonce, port, logPath });
  throw new Error(`readiness timeout or process exit for instance ${nonce} on port ${port}; inspect ${logPath} and ${join(state, "init-failure.json")}`);
 } finally {
   if (serverOwned && !serverDetached) await terminateOwnedSupervisor(serverOwned).catch((error) => {
     process.stderr.write(`failed to terminate owned server supervisor: ${error?.stack ?? error}\n`);
   });
   if (activeServer === serverOwned) activeServer = undefined;
   await releaseLock();
 }
}

async function runSmoke(instance, state) {
  const { runLocalSandboxSmoke } = await import("./local-sandbox-smoke.mjs");
  return runLocalSandboxSmoke({
    baseUrl: `http://127.0.0.1:${instance.port}`,
    storageRoot: join(state, "local-data"),
  });
}

function commandExists(command) {
  return run(command, ["--version"], { env: { PATH: process.env.PATH }, stdio: "ignore" }, `${command} prerequisite check`)
    .then(() => true)
    .catch((error) => {
      if (error?.code === "ENOENT" || error?.kind === "exit") return false;
      throw error;
    });
}

async function run(command, commandArgs, options, label) {
  shutdownController.signal.throwIfAborted();
  let prerequisite;
  try {
    prerequisite = await spawnSupervisedProcess(command, commandArgs, options, { signal: shutdownController.signal });
  } catch (cause) {
    const error = new Error(`${label} failed to start: ${cause?.message ?? cause}`, { cause });
    error.code = cause?.code;
    throw error;
  }
  activePrerequisite = prerequisite;
  await phaseBarrier("active_prerequisite");
  let result;
  try { result = await boundedOutcome(prerequisite.outcome, prerequisiteTimeoutMs, { timedOut: true }, shutdownController.signal); }
  finally {
    await terminateOwnedSupervisor(prerequisite, result && !result.timedOut && !shutdownController.signal.aborted ? { graceMs: 20 } : undefined);
    if (activePrerequisite === prerequisite) activePrerequisite = undefined;
  }
  if (result.timedOut) {
    const error = new Error(`${label} timed out after ${prerequisiteTimeoutMs}ms`);
    error.kind = "timeout";
    throw error;
  }
  if (result.error) {
    const error = new Error(`${label} failed to start: ${result.error.message}`, { cause: result.error });
    error.code = result.error.code;
    throw error;
  }
  if (result.code !== 0) {
    const error = new Error(`${label} failed (${result.signal ?? result.code})`);
    error.kind = "exit";
    throw error;
  }
}

function requestShutdown(signal) {
  shutdownSignal ??= signal;
  if (!shutdownController.signal.aborted) shutdownController.abort(new Error(`init cancelled by ${shutdownSignal}`));
}

async function exitForSignal() {
  for (const [signal, handler] of shutdownHandlers) process.off(signal, handler);
  // SIGKILL cannot be intercepted; cleanup after it requires an external OS-level supervisor.
  try { process.kill(process.pid, shutdownSignal); }
  catch { process.exitCode = shutdownSignal === "SIGINT" ? 130 : 143; }
}

function boundedOutcome(promise, timeoutMs, timeoutValue, signal) {
  return new Promise((resolveOutcome, rejectOutcome) => {
    let settled = false;
    const timer = setTimeout(() => finish(timeoutValue), timeoutMs);
    timer.unref();
    promise.then(finish);
    const onAbort = () => finish(undefined, signal.reason instanceof Error ? signal.reason : new Error("init cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    function finish(value, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) rejectOutcome(error); else resolveOutcome(value);
    }
  });
}

function abortableDelay(ms, signal) {
  return boundedOutcome(new Promise((resolveDelay) => setTimeout(resolveDelay, ms)), ms + 10, undefined, signal);
}

async function phaseBarrier(phase) {
  if (process.env.HARNESS_INIT_TEST_PHASE !== phase || process.env.NODE_ENV !== "test") return;
  const marker = process.env.HARNESS_INIT_TEST_PHASE_MARKER;
  const gate = process.env.HARNESS_INIT_TEST_PHASE_GATE;
  if (!marker || !gate) throw new Error("init test phase barrier requires marker and gate paths");
  const { atomicWriteFile } = await import("../lib/file-storage-lock.mjs");
  await atomicWriteFile(marker, JSON.stringify({
    phase,
    pid: process.pid,
    supervisor_pid: activePrerequisite?.supervisorPid ?? activeServer?.supervisorPid,
  }));
  while (!await exists(gate)) await abortableDelay(10, shutdownController.signal);
}

function positiveTimeout(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function instanceOutput(mode, instance, extra, state) {
  return {
    ok: true,
    mode,
    pid: instance.pid,
    nonce: instance.nonce,
    port: instance.port,
    url: `http://127.0.0.1:${instance.port}/api/ready`,
    storage: join(state, "local-data"),
    log: join(state, "init.log"),
    ...extra,
  };
}
