import { access, open, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  acquireInitLock,
  assertNodeVersion,
  assertSafeStateDirectory,
  chooseAvailablePort,
  failTimedOutStart,
  isProcessAlive,
  inspectSafeStateDirectory,
  probeInstance,
  probeLocalInstance,
  readInstanceMetadata,
  readManagedLocalConfig,
  removeInstanceMetadataIfOwned,
  resetLocalData,
  safeChildEnv,
  spawnProcessGroup,
  terminateProcessGroup,
  waitForOwnershipHandshake,
} from "./init-lib.mjs";

const worktree = resolve(process.cwd());
const args = new Set(process.argv.slice(2));
const validArgs = new Set(["--check", "--no-install", "--reset"]);
const json = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const exists = async (path) => access(path).then(() => true).catch(() => false);
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const prerequisiteTimeoutMs = positiveTimeout(process.env.HARNESS_INIT_PREREQUISITE_TIMEOUT_MS, 120_000);

if ([...args].some((arg) => !validArgs.has(arg)) || (args.has("--reset") && args.size > 1)) {
  throw new Error("usage: ./scripts/init.sh [--check] [--no-install] [--reset]");
}
assertNodeVersion(process.versions.node);

if (args.has("--reset")) {
  const result = await resetLocalData(worktree);
  json({ ok: true, mode: "reset", ...result });
  process.exit(0);
}

if (args.has("--check")) await checkOnly();
else await initialize(await assertSafeStateDirectory(worktree));

async function checkOnly() {
  const inspected = await inspectSafeStateDirectory(worktree);
  const pnpm = await commandExists("pnpm");
  if (!pnpm) throw new Error("pnpm is required and was not found on PATH");
  const observed = inspected.exists ? await inspectPidForCheck(inspected.state) : { state: "absent" };
  if (observed.state === "live") {
    if (observed.legacy) throw new Error(`legacy PID metadata points to live process ${observed.pid}; stop it before restarting`);
    const owned = await probeLocalInstance(observed.metadata);
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
 const releaseLock = await acquireInitLock(lockPath);
 try {
  const pnpm = await commandExists("pnpm");
  if (!pnpm) throw new Error("pnpm is required and was not found on PATH");

  let stalePidRecovered = false;
  const metadata = await readInstanceMetadata(state);
  if (metadata) {
    if (isProcessAlive(metadata.pid)) {
      const ready = await probeInstance(metadata);
      if (!ready) throw new Error(`local PID ${metadata.pid} is alive but readiness ownership did not match; refusing a second server`);
      json(instanceOutput("existing", metadata, { stale_pid_recovered: false }, state));
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
  const installEnv = await safeChildEnv(worktree, process.env, localConfig);
  if (!args.has("--no-install")) await run("pnpm", ["install", "--frozen-lockfile"], { cwd: worktree, env: installEnv, stdio: "inherit" }, "pnpm install");

  await run(process.execPath, ["scripts/seed-local.mjs"], { cwd: worktree, env: installEnv, stdio: "inherit" }, "local seed");
  const nextBin = join(worktree, "node_modules", "next", "dist", "bin", "next");
  if (!(await exists(nextBin))) throw new Error("Next.js is not installed; rerun without --no-install");

  const nonce = randomUUID();
  const serverEnv = await safeChildEnv(worktree, process.env, { ...localConfig, LOCAL_INSTANCE_NONCE: nonce });
  serverEnv.HARNESS_INIT_STATE = state;
  serverEnv.LOCAL_INSTANCE_PORT = String(port);
  const logHandle = await open(logPath, "a", 0o600);
  const child = spawnProcessGroup(process.execPath, ["scripts/local-next-wrapper.mjs", nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: worktree,
    env: serverEnv,
    stdio: ["ignore", logHandle.fd, logHandle.fd, "pipe"],
  });
  await logHandle.close();
  const instance = { pid: child.pid, nonce, port, started_at: new Date().toISOString() };
  try {
    await waitForOwnershipHandshake(child, instance);
  } catch (error) {
    await terminateProcessGroup(child.pid);
    await removeInstanceMetadataIfOwned(state, instance);
    throw error;
  }
  child.stdio[3]?.destroy();
  child.unref();

  const timeoutMs = Number.parseInt(process.env.HARNESS_INIT_READY_TIMEOUT_MS ?? "30000", 10);
  const deadline = Date.now() + (Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000);
  while (Date.now() < deadline) {
    if (await probeInstance(instance, 500)) {
      await rm(join(state, "init-failure.json"), { force: true });
      json(instanceOutput("start", instance, { stale_pid_recovered: stalePidRecovered }, state));
      return;
    }
    if (!isProcessAlive(child.pid)) break;
    await delay(100);
  }
  await failTimedOutStart({ worktree, pid: child.pid, nonce, port, logPath });
  throw new Error(`readiness timeout or process exit for instance ${nonce} on port ${port}; inspect ${logPath} and ${join(state, "init-failure.json")}`);
 } finally {
   await releaseLock();
 }
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
  const child = spawnProcessGroup(command, commandArgs, options);
  const outcome = new Promise((resolveOutcome) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolveOutcome(value); } };
    child.once("error", (error) => finish({ error }));
    child.once("close", (code, signal) => finish({ code, signal }));
  });
  const result = await boundedOutcome(outcome, prerequisiteTimeoutMs, { timedOut: true });
  if (result.timedOut) {
    await terminateProcessGroup(child.pid);
    await boundedOutcome(outcome, 1_000, undefined);
    const error = new Error(`${label} timed out after ${prerequisiteTimeoutMs}ms`);
    error.kind = "timeout";
    throw error;
  }
  await terminateProcessGroup(child.pid);
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

function boundedOutcome(promise, timeoutMs, timeoutValue) {
  return new Promise((resolveOutcome) => {
    let settled = false;
    const timer = setTimeout(() => finish(timeoutValue), timeoutMs);
    timer.unref();
    promise.then(finish);
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutcome(value);
    }
  });
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
