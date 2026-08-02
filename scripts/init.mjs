import { access, open, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import {
  acquireInitLock,
  assertNodeVersion,
  assertSafeStateDirectory,
  chooseAvailablePort,
  failTimedOutStart,
  isProcessAlive,
  probeInstance,
  readInstanceMetadata,
  readManagedLocalConfig,
  resetLocalData,
  safeChildEnv,
  spawnProcessGroup,
  writeInstanceMetadata,
} from "./init-lib.mjs";

const worktree = resolve(process.cwd());
const args = new Set(process.argv.slice(2));
const validArgs = new Set(["--check", "--no-install", "--reset"]);
const json = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const exists = async (path) => access(path).then(() => true).catch(() => false);
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

if ([...args].some((arg) => !validArgs.has(arg)) || (args.has("--reset") && args.size > 1)) {
  throw new Error("usage: ./scripts/init.sh [--check] [--no-install] [--reset]");
}
assertNodeVersion(process.versions.node);

if (args.has("--reset")) {
  const result = await resetLocalData(worktree);
  json({ ok: true, mode: "reset", ...result });
  process.exit(0);
}

const state = await assertSafeStateDirectory(worktree);
const pidPath = join(state, "init.pid");
const lockPath = join(state, "init.lock");
const logPath = join(state, "init.log");
await initialize();

async function initialize() {
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
      json(instanceOutput("existing", metadata, { stale_pid_recovered: false }));
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
  if (args.has("--check")) {
    json({ ok: true, mode: "check", port, storage: join(state, "local-data"), stale_pid_recovered: stalePidRecovered });
    return;
  }

  const localConfig = await readManagedLocalConfig(worktree);
  const installEnv = await safeChildEnv(worktree, process.env, localConfig);
  if (!args.has("--no-install")) await run("pnpm", ["install", "--frozen-lockfile"], { cwd: worktree, env: installEnv, stdio: "inherit" }, "pnpm install");

  await run(process.execPath, ["scripts/seed-local.mjs"], { cwd: worktree, env: installEnv, stdio: "inherit" }, "local seed");
  const nextBin = join(worktree, "node_modules", "next", "dist", "bin", "next");
  if (!(await exists(nextBin))) throw new Error("Next.js is not installed; rerun without --no-install");

  const nonce = randomUUID();
  const serverEnv = await safeChildEnv(worktree, process.env, { ...localConfig, LOCAL_INSTANCE_NONCE: nonce });
  const logHandle = await open(logPath, "a", 0o600);
  const child = spawnProcessGroup(process.execPath, ["scripts/local-next-wrapper.mjs", nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: worktree,
    env: serverEnv,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  });
  await logHandle.close();
  const instance = { pid: child.pid, nonce, port, started_at: new Date().toISOString() };
  await writeInstanceMetadata(state, instance);
  child.unref();

  const timeoutMs = Number.parseInt(process.env.HARNESS_INIT_READY_TIMEOUT_MS ?? "30000", 10);
  const deadline = Date.now() + (Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000);
  while (Date.now() < deadline) {
    if (await probeInstance(instance, 500)) {
      await rm(join(state, "init-failure.json"), { force: true });
      json(instanceOutput("start", instance, { stale_pid_recovered: stalePidRecovered }));
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
  return new Promise((resolveCommand) => {
    const child = spawn(command, ["--version"], { env: { PATH: process.env.PATH }, stdio: "ignore" });
    child.once("error", () => resolveCommand(false));
    child.once("exit", (code) => resolveCommand(code === 0));
  });
}

function run(command, commandArgs, options, label) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, options);
    child.once("error", (error) => rejectRun(new Error(`${label} failed to start: ${error.message}`)));
    child.once("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${label} failed (${code})`)));
  });
}

function instanceOutput(mode, instance, extra) {
  return {
    ok: true,
    mode,
    pid: instance.pid,
    nonce: instance.nonce,
    port: instance.port,
    url: `http://127.0.0.1:${instance.port}/api/ready`,
    storage: join(state, "local-data"),
    log: logPath,
    ...extra,
  };
}
