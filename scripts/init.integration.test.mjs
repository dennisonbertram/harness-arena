import { spawn } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { atomicWriteFile } from "../lib/file-storage-lock.mjs";

const repositoryRoot = process.cwd();
const cleanupRoots = new Set();
const checkoutRoots = new Set();
const launcherGroups = new Set();
const serverGroups = new Set();
const operatorEnvBytes = Buffer.from("AI_GATEWAY_API_KEY=gateway-env-sentinel\r\nRUNNER_CALLBACK_SECRET=runner-env-sentinel\nHARMLESS_SENTINEL=harmless-env-sentinel\n", "utf8");
const operatorEnvMode = 0o640;
const operatorEnvLocalBytes = Buffer.from([
  "# harness-arena-init:v2",
  "# Local-only; never copy production secrets here.",
  "STORAGE=file",
  "LOCAL_STORAGE_DIR=__STATE__/local-data",
  "AUTH_SECRET=hermetic-local-auth",
  "",
].join("\n"), "utf8");
const operatorEnvLocalMode = 0o600;
const metaMode = process.env.HARNESS_INIT_META_MODE;
let root;
let state;

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
let cleanupPromise;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void cleanupHarness().catch((error) => process.stderr.write(`${error?.stack ?? error}\n`)).finally(() => {
      process.kill(process.pid, signal);
    });
  });
}
process.once("beforeExit", () => { void cleanupHarness().catch(() => {}); });
process.once("exit", forceKillOwnedGroups);

beforeAll(async () => {
  root = await createHermeticCheckout("harness-arena-init-integration-", { withFakeNext: true });
  state = join(root, ".harness-arena");
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(root, ".env"), operatorEnvBytes, { mode: operatorEnvMode });
  await chmod(join(root, ".env"), operatorEnvMode);
  await writeFile(join(root, ".env.local"), managedEnvLocalBytes(), { mode: operatorEnvLocalMode });
  await chmod(join(root, ".env.local"), operatorEnvLocalMode);
}, 30_000);

function managedEnvLocalBytes() {
  return Buffer.from(operatorEnvLocalBytes.toString("utf8").replace("__STATE__", state), "utf8");
}

function runInit(...args) {
  return runInitWithEnv({}, ...args);
}

function runInitWithEnv(extraEnv, ...args) {
  return runInitAt(root, extraEnv, ...args);
}

function runInitAt(cwd, extraEnv, ...args) {
  return new Promise((resolve) => {
    const child = spawn("./scripts/init.sh", args, {
      cwd,
      detached: true,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        BLOB_READ_WRITE_TOKEN: "inherited-blob-sentinel",
        RANDOM_PARENT_SECRET: "parent-sentinel",
        ...extraEnv,
      },
    });
    launcherGroups.add(child.pid);
    let stdout = ""; let stderr = ""; let settled = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}` }));
    child.once("close", (code, signal) => finish({ code, signal, stdout, stderr }));

    async function finish(result) {
      if (settled) return;
      settled = true;
      try { await waitForProcessGroupExit(child.pid); } catch { await terminateProcessGroup(child.pid); }
      launcherGroups.delete(child.pid);
      const output = parseLastJson(result.stdout);
      if (Number.isSafeInteger(output?.pid) && output.pid > 0) serverGroups.add(output.pid);
      resolve(result);
    }
  });
}

async function createHermeticCheckout(prefix, { withFakeNext = false } = {}) {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  cleanupRoots.add(parent);
  const checkout = join(parent, "checkout");
  checkoutRoots.add(checkout);
  await mkdir(join(checkout, "scripts"), { recursive: true });
  await mkdir(join(checkout, "lib"), { recursive: true });
  await mkdir(join(checkout, ".git"), { recursive: true });
  await writeFile(join(checkout, ".git", "HEAD"), "ref: refs/heads/codex/init-integration\n");
  for (const path of ["scripts/init.sh", "scripts/init.mjs", "scripts/init-lib.mjs", "scripts/init-process-supervisor.mjs", "scripts/init-command-group-anchor.mjs", "scripts/local-next-wrapper.mjs", "scripts/seed-local.mjs", "lib/file-storage-lock.mjs"]) {
    await cp(join(repositoryRoot, path), join(checkout, path));
  }
  await chmod(join(checkout, "scripts/init.sh"), 0o755);
  if (withFakeNext) await installFakeNext(checkout);
  return realpath(checkout);
}

async function installFakeNext(checkout) {
  const nextBin = join(checkout, "node_modules", "next", "dist", "bin", "next");
  await mkdir(join(nextBin, ".."), { recursive: true });
  await writeFile(nextBin, [
    "const { appendFileSync, existsSync } = require('node:fs');",
    "const { createServer } = require('node:http');",
    "const { join } = require('node:path');",
    "const args = process.argv.slice(2);",
    "const port = Number(args[args.indexOf('--port') + 1]);",
    "const hostname = args[args.indexOf('--hostname') + 1];",
    "const sanitized = !Object.values(process.env).some((value) => String(value).includes('sentinel'));",
    "const seeded = existsSync(join(process.env.LOCAL_STORAGE_DIR, 'competitions', 'local-development.json'));",
    "const ready = { ok: true, pid: Number(process.env.LOCAL_INSTANCE_PID), nonce: process.env.LOCAL_INSTANCE_NONCE, seeded, writable: true, environment_sanitized: sanitized };",
    "const health = { ok: true, gateway_key_present: Boolean(process.env.AI_GATEWAY_API_KEY), runner_secret_present: Boolean(process.env.RUNNER_CALLBACK_SECRET) };",
    "const requestLog = join(process.env.HARNESS_INIT_STATE, '..', '..', 'fake-next-requests.log');",
    "const server = createServer((request, response) => {",
    "  appendFileSync(requestLog, `${request.url}\\n`);",
    "  if (request.url === '/api/local-instance') {",
    "    const accepted = process.env.HARNESS_LOCAL_INIT === '1' && process.env.STORAGE === 'file' && request.headers['x-harness-local-instance-nonce'] === process.env.LOCAL_INSTANCE_NONCE;",
    "    response.writeHead(accepted ? 204 : 404, { 'cache-control': 'no-store' });",
    "    response.end();",
    "    return;",
    "  }",
    "  const body = request.url === '/api/ready' ? ready : request.url === '/api/health' ? health : { error: 'not_found' };",
    "  response.writeHead(request.url === '/api/ready' || request.url === '/api/health' ? 200 : 404, { 'content-type': 'application/json' });",
    "  response.end(JSON.stringify(body));",
    "});",
    "for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));",
    "server.listen(port, hostname);",
  ].join("\n"), { mode: 0o700 });
}

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(path, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await delay(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForProcessGroupExit(pid, timeoutMs = 5_000) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); } catch (error) { if (error?.code !== "EPERM") return; }
    await delay(25);
  }
  throw new Error(`timed out waiting for process group ${pid} to exit`);
}

async function terminateProcessGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, "SIGTERM"); } catch {}
  try { await waitForProcessGroupExit(pid, 1_500); return; } catch {}
  try { process.kill(-pid, "SIGKILL"); } catch {}
  await waitForProcessGroupExit(pid);
}

async function stopOwnedInstance() {
  let metadata;
  try { metadata = JSON.parse(await readFile(join(state, "init.pid"), "utf8")); } catch {}
  if (!Number.isSafeInteger(metadata?.pid)) return;
  serverGroups.add(metadata.pid);
  await terminateProcessGroup(metadata.pid);
  serverGroups.delete(metadata.pid);
  await waitForFileRemoval(join(state, "init.pid"));
}

async function waitForFileRemoval(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await lstat(path); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
    await delay(25);
  }
  throw new Error(`timed out waiting for removal of ${path}`);
}

function parseLastJson(stdout) {
  try { return JSON.parse(stdout.trim().split("\n").at(-1)); } catch { return undefined; }
}

async function fileSnapshot(path) {
  const info = await stat(path);
  return { bytes: await readFile(path), mode: info.mode & 0o777 };
}

async function expectOperatorEnvPreserved(expected = { bytes: operatorEnvBytes, mode: operatorEnvMode }) {
  const actual = await fileSnapshot(join(root, ".env"));
  expect(actual.bytes.equals(expected.bytes)).toBe(true);
  expect(actual.mode).toBe(expected.mode);
}

async function expectOperatorEnvsPreserved() {
  await expectOperatorEnvPreserved();
  const actual = await fileSnapshot(join(root, ".env.local"));
  expect(actual.bytes.equals(managedEnvLocalBytes())).toBe(true);
  expect(actual.mode).toBe(operatorEnvLocalMode);
}

async function snapshotTree(path) {
  const output = {};
  await visit(path, "");
  return output;

  async function visit(current, name) {
    const info = await lstat(current, { bigint: true });
    const key = name || ".";
    const identity = { ino: String(info.ino), mode: Number(info.mode & 0o777n), mtime_ns: String(info.mtimeNs), ctime_ns: String(info.ctimeNs) };
    if (info.isSymbolicLink()) { output[key] = { type: "symlink", ...identity, target: await readlink(current) }; return; }
    if (info.isDirectory()) {
      output[key] = { type: "directory", ...identity };
      for (const entry of (await readdir(current)).sort()) await visit(join(current, entry), name ? `${name}/${entry}` : entry);
      return;
    }
    output[key] = { type: "file", ...identity, bytes: (await readFile(current)).toString("base64") };
  }
}

async function fakePnpm(checkout, label, exitCode = 0) {
  const bin = join(checkout, "..", `bin-${label}`);
  const marker = join(checkout, "..", `pnpm-${label}.pid`);
  await mkdir(bin);
  const path = join(bin, "pnpm");
  await writeFile(path, [
    "#!/usr/bin/env node",
    `import { atomicWriteFile } from ${JSON.stringify(join(checkout, "lib", "file-storage-lock.mjs"))};`,
    `await atomicWriteFile(${JSON.stringify(marker)}, String(process.pid));`,
    `process.exit(${exitCode});`,
  ].join("\n"));
  await chmod(path, 0o700);
  return { marker, path: `${bin}:${process.env.PATH}` };
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function fakeHungPnpm(checkout, label, eventPath, markerDelayMs = 0) {
  const bin = join(checkout, "..", `bin-${label}`);
  const marker = join(checkout, "..", `pnpm-${label}.json`);
  const events = eventPath ?? join(checkout, "..", `pnpm-${label}.events`);
  await mkdir(bin);
  const path = join(bin, "pnpm");
  await writeFile(path, [
    "#!/usr/bin/env node",
    "import { spawn } from 'node:child_process';",
    "import { appendFileSync } from 'node:fs';",
    "import { readFile } from 'node:fs/promises';",
    `import { atomicWriteFile } from ${JSON.stringify(join(checkout, "lib", "file-storage-lock.mjs"))};`,
    `const events = ${JSON.stringify(events)};`,
    "process.on('SIGTERM', () => appendFileSync(events, 'leader:SIGTERM\\n'));",
    "const descendant = `const { appendFileSync } = require('node:fs'); const events = process.argv[1]; process.on('SIGTERM', () => appendFileSync(events, 'descendant:SIGTERM\\\\n')); appendFileSync(events, 'descendant:ready\\\\n'); setInterval(() => {}, 1000);`;",
    "const child = spawn(process.execPath, ['-e', descendant, events], { stdio: 'ignore' });",
    "while (!(await readFile(events, 'utf8').catch(() => '')).includes('descendant:ready')) await new Promise((resolve) => setTimeout(resolve, 10));",
    `if (${markerDelayMs} > 0) await new Promise((resolve) => setTimeout(resolve, ${markerDelayMs}));`,
    `await atomicWriteFile(${JSON.stringify(marker)}, JSON.stringify({ init: Number(process.env.HARNESS_INIT_LAUNCHER_PID), leader: Number(process.env.HARNESS_INIT_SUPERVISOR_PID), command: process.pid, child: child.pid }));`,
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  await chmod(path, 0o700);
  return { events, marker, path: `${bin}:${process.env.PATH}` };
}

function cleanupHarness() {
  if (!cleanupPromise) cleanupPromise = performCleanup();
  return cleanupPromise;
}

async function performCleanup() {
  if (process.env.HARNESS_INIT_META_PRESERVATION_MARKER && root) {
    let preserved = false;
    try {
      const env = await fileSnapshot(join(root, ".env"));
      const local = await fileSnapshot(join(root, ".env.local"));
      preserved = env.bytes.equals(operatorEnvBytes) && env.mode === operatorEnvMode
        && local.bytes.equals(managedEnvLocalBytes()) && local.mode === operatorEnvLocalMode;
    } catch {}
    await atomicWriteFile(process.env.HARNESS_INIT_META_PRESERVATION_MARKER, JSON.stringify({ preserved }));
  }
  for (const checkout of checkoutRoots) {
    try {
      const metadata = JSON.parse(await readFile(join(checkout, ".harness-arena", "init.pid"), "utf8"));
      if (Number.isSafeInteger(metadata?.pid) && processIsAlive(metadata.pid)) serverGroups.add(metadata.pid);
    } catch {}
  }
  const errors = [];
  for (const pid of [...launcherGroups, ...serverGroups]) {
    try { await terminateProcessGroup(pid); } catch (error) { errors.push(error); }
  }
  launcherGroups.clear(); serverGroups.clear();
  for (const path of cleanupRoots) await rm(path, { recursive: true, force: true });
  if (errors.length) throw new AggregateError(errors, "failed to reap integration process groups");
}

function forceKillOwnedGroups() {
  for (const pid of [...launcherGroups, ...serverGroups]) {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
}

afterAll(cleanupHarness, 30_000);

describe.sequential("init process ownership integration", () => {
  it("makes simultaneous starts converge on one live owned instance and makes rerun/check idempotent", async () => {
    await rm(join(state, "init.pid"), { force: true });
    await rm(join(state, "init.lock"), { recursive: true, force: true });
    const [a, b] = await Promise.all([runInit("--no-install"), runInit("--no-install")]);
    const initLog = await readFile(join(state, "init.log"), "utf8").catch(() => "init log unavailable");
    expect([a.code, b.code], `${a.stderr}\n${b.stderr}\n${initLog}`).toEqual([0, 0]);
    const first = parseLastJson(a.stdout);
    const second = parseLastJson(b.stdout);
    expect(second.pid).toBe(first.pid);
    expect(second.nonce).toBe(first.nonce);
    expect(new Set([first.mode, second.mode])).toEqual(new Set(["start", "existing"]));
    const ready = await fetch(first.url).then((response) => response.json());
    expect(ready).toMatchObject({ ok: true, pid: first.pid, nonce: first.nonce, seeded: true, writable: true, environment_sanitized: true });

    const rerun = await runInit("--no-install");
    const check = await runInit("--check");
    expect(parseLastJson(rerun.stdout).mode).toBe("existing");
    expect(parseLastJson(check.stdout).mode).toBe("existing");
    await expectOperatorEnvsPreserved();
  }, 30_000);

  it("does not expose inherited or env-file sentinel values through health", async () => {
    const metadata = JSON.parse(await readFile(join(state, "init.pid"), "utf8"));
    const health = await fetch(`http://127.0.0.1:${metadata.port}/api/health`).then((response) => response.text());
    expect(health).not.toMatch(/sentinel/);
    expect(JSON.parse(health)).toMatchObject({ gateway_key_present: false, runner_secret_present: true });
    await expectOperatorEnvsPreserved();
  });

  it("lets a simultaneous caller outwait a cold install and report the same owned instance", async () => {
    await stopOwnedInstance();
    await rm(join(state, "init.pid"), { force: true });

    const fakeRoot = await mkdtemp(join(tmpdir(), "harness-arena-slow-pnpm-"));
    cleanupRoots.add(fakeRoot);
    const fakeBin = join(fakeRoot, "bin");
    const marker = join(fakeRoot, "install-started");
    await mkdir(fakeBin);
    const fakePnpmPath = join(fakeBin, "pnpm");
    await writeFile(fakePnpmPath, [
      "#!/usr/bin/env node",
      `import { atomicWriteFile } from ${JSON.stringify(join(repositoryRoot, "lib", "file-storage-lock.mjs"))};`,
      "if (process.argv[2] === '--version') { console.log('10.0.0'); process.exit(0); }",
      `if (process.argv[2] === 'install') { await atomicWriteFile(${JSON.stringify(marker)}, 'started'); await new Promise((resolve) => setTimeout(resolve, 16_000)); process.exit(0); }`,
      "process.exit(2);",
    ].join("\n"));
    await chmod(fakePnpmPath, 0o700);
    const env = { PATH: `${fakeBin}:${process.env.PATH}` };

    const owner = runInitWithEnv(env);
    await waitForFile(marker);
    const simultaneous = runInitWithEnv(env, "--no-install");
    const [first, second] = await Promise.all([owner, simultaneous]);
    expect([first.code, second.code], `${first.stderr}\n${second.stderr}`).toEqual([0, 0]);
    const firstInstance = parseLastJson(first.stdout);
    const secondInstance = parseLastJson(second.stdout);
    expect(firstInstance).toMatchObject({ mode: "start" });
    expect(secondInstance).toMatchObject({ mode: "existing", pid: firstInstance.pid, nonce: firstInstance.nonce });
    await expectOperatorEnvsPreserved();
  }, 60_000);

  it("preserves operator .env and managed .env.local bytes and modes on failed setup", async () => {
    await stopOwnedInstance();
    const envLocal = await fileSnapshot(join(root, ".env.local"));
    const brokenPnpm = await fakePnpm(root, "failure", 2);
    const result = await runInitWithEnv({ PATH: brokenPnpm.path }, "--no-install");
    expect(result.code).not.toBe(0);
    expect(processIsAlive(Number.parseInt(await readFile(brokenPnpm.marker, "utf8"), 10))).toBe(false);
    await expectOperatorEnvsPreserved();
    const envLocalAfter = await fileSnapshot(join(root, ".env.local"));
    expect(envLocalAfter.bytes.equals(envLocal.bytes)).toBe(true);
    expect(envLocalAfter.mode).toBe(envLocal.mode);
  });

  it("preserves operator env files and reaps the timed-out server process group", async () => {
    const envLocal = await fileSnapshot(join(root, ".env.local"));
    await rm(join(root, "node_modules"), { recursive: true, force: true });
    const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
    await mkdir(join(nextBin, ".."), { recursive: true });
    await writeFile(nextBin, "setInterval(() => {}, 1000);\n", { mode: 0o700 });
    const result = await runInitWithEnv({ HARNESS_INIT_READY_TIMEOUT_MS: "75" }, "--no-install");
    expect(result.code).not.toBe(0);
    const failure = JSON.parse(await readFile(join(state, "init-failure.json"), "utf8"));
    await expect(waitForProcessGroupExit(failure.pid)).resolves.toBeUndefined();
    await expectOperatorEnvsPreserved();
    const envLocalAfter = await fileSnapshot(join(root, ".env.local"));
    expect(envLocalAfter.bytes.equals(envLocal.bytes)).toBe(true);
    expect(envLocalAfter.mode).toBe(envLocal.mode);
  }, 15_000);
});

describe.sequential("read-only init check integration", () => {
  it("uses only the local nonce-authenticated identity probe and preserves file identity and write metadata", async () => {
    await installFakeNext(root);
    const started = await runInit("--no-install");
    expect(started.code, started.stderr).toBe(0);
    expect(parseLastJson(started.stdout)).toMatchObject({ mode: "start" });
    const requestLog = join(root, "..", "fake-next-requests.log");
    await writeFile(requestLog, "");
    const before = await snapshotTree(root);
    const result = await runInit("--check");
    expect(result.code, result.stderr).toBe(0);
    expect(parseLastJson(result.stdout)).toMatchObject({ mode: "existing" });
    expect((await readFile(requestLog, "utf8")).trim().split("\n")).toEqual(["/api/local-instance"]);
    expect(await snapshotTree(root)).toEqual(before);
    await expectOperatorEnvsPreserved();
  });

  it("bounds and reaps a hung pnpm prerequisite process group", async () => {
    const checkout = await createHermeticCheckout("harness-arena-check-hung-pnpm-");
    const prerequisiteTimeoutMs = 500;
    // The operation owns one prerequisite deadline plus bounded process-group
    // cleanup. Keep fixture scheduling slack proportional to that deadline so
    // this remains stable when the full suite competes for a test worker.
    const operationBoundMs = prerequisiteTimeoutMs * 4;
    const pnpm = await fakeHungPnpm(checkout, "hung", undefined, prerequisiteTimeoutMs / 2);
    const invocation = runInitAt(checkout, { PATH: pnpm.path, HARNESS_INIT_PREREQUISITE_TIMEOUT_MS: String(prerequisiteTimeoutMs) }, "--check");
    const pids = JSON.parse(await waitForFile(pnpm.marker, operationBoundMs));
    const started = Date.now();
    const result = await Promise.race([invocation, delay(operationBoundMs).then(() => ({ timedOut: true }))]);
    if (result.timedOut) {
      for (const pid of launcherGroups) await terminateProcessGroup(pid).catch(() => {});
    }
    expect(result.timedOut).not.toBe(true);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(operationBoundMs);
    await expect(waitForProcessGroupExit(pids.leader, operationBoundMs)).resolves.toBeUndefined();
    expect(processIsAlive(pids.child)).toBe(false);
  }, 10_000);

  it("creates no state or surviving prerequisite process in a valid checkout", async () => {
    const checkout = await createHermeticCheckout("harness-arena-check-valid-");
    const pnpm = await fakePnpm(checkout, "valid");
    const before = await snapshotTree(checkout);
    const result = await runInitAt(checkout, { PATH: pnpm.path }, "--check");
    const prerequisitePid = Number.parseInt(await readFile(pnpm.marker, "utf8"), 10);
    expect(result.code).toBe(0);
    expect(parseLastJson(result.stdout)).toMatchObject({ ok: true, mode: "check", stale_pid_detected: false });
    expect(processIsAlive(prerequisitePid)).toBe(false);
    expect(await snapshotTree(checkout)).toEqual(before);
  });

  it("reports stale metadata without deleting or modifying any fixture bytes, modes, or lock artifacts", async () => {
    const checkout = await createHermeticCheckout("harness-arena-check-stale-");
    const localState = join(checkout, ".harness-arena");
    await mkdir(join(localState, "init.lock"), { recursive: true, mode: 0o750 });
    await writeFile(join(localState, "init.lock", "operator-note"), "do-not-touch\n", { mode: 0o640 });
    await writeFile(join(localState, "init.pid"), '{"pid":99999999,"nonce":"stale","port":29998}', { mode: 0o640 });
    await writeFile(join(checkout, ".env.local"), "OPERATOR_MANAGED=no\n", { mode: 0o640 });
    const pnpm = await fakePnpm(checkout, "stale");
    const before = await snapshotTree(checkout);
    const result = await runInitAt(checkout, { PATH: pnpm.path }, "--check");
    const prerequisitePid = Number.parseInt(await readFile(pnpm.marker, "utf8"), 10);
    expect(result.code).toBe(0);
    expect(parseLastJson(result.stdout)).toMatchObject({ ok: true, mode: "check", stale_pid_detected: true });
    expect(processIsAlive(prerequisitePid)).toBe(false);
    expect(await snapshotTree(checkout)).toEqual(before);
  });

  it("fails closed on partial PID metadata and symlinked state without repairing either fixture", async () => {
    const partial = await createHermeticCheckout("harness-arena-check-partial-");
    await mkdir(join(partial, ".harness-arena"));
    await writeFile(join(partial, ".harness-arena", "init.pid"), '{"pid":', { mode: 0o640 });
    const partialPnpm = await fakePnpm(partial, "partial");
    const partialBefore = await snapshotTree(partial);
    const partialResult = await runInitAt(partial, { PATH: partialPnpm.path }, "--check");
    expect(partialResult.code).not.toBe(0);
    expect(await snapshotTree(partial)).toEqual(partialBefore);

    const symlinked = await createHermeticCheckout("harness-arena-check-symlink-");
    const outside = join(symlinked, "..", "operator-state");
    await mkdir(outside);
    await writeFile(join(outside, "keep"), "keep\n", { mode: 0o640 });
    await symlink(outside, join(symlinked, ".harness-arena"));
    const symlinkPnpm = await fakePnpm(symlinked, "symlink");
    const symlinkBefore = await snapshotTree(symlinked);
    const outsideBefore = await snapshotTree(outside);
    const symlinkResult = await runInitAt(symlinked, { PATH: symlinkPnpm.path }, "--check");
    expect(symlinkResult.code).not.toBe(0);
    expect(await snapshotTree(symlinked)).toEqual(symlinkBefore);
    expect(await snapshotTree(outside)).toEqual(outsideBefore);
  });
});

describe.skipIf(!["signal", "normal", "assertion"].includes(metaMode))("test-worker cleanup fixture", () => {
  it("publishes a fake server before the worker is interrupted or fails", async () => {
    const result = await runInit("--no-install");
    expect(result.code, result.stderr).toBe(0);
    const instance = parseLastJson(result.stdout);
    await atomicWriteFile(process.env.HARNESS_INIT_META_MARKER, JSON.stringify({ worker_pid: process.pid, server_pid: instance.pid }));
    if (metaMode === "assertion") expect("deliberate assertion failure").toBe("success");
    if (metaMode === "normal") return;
    await new Promise(() => {});
  });
});

describe.skipIf(!metaMode?.startsWith("prerequisite-"))("test-worker prerequisite interruption fixture", () => {
  it("publishes a hung prerequisite leader and descendant before interruption", async () => {
    const pnpm = await fakeHungPnpm(root, `meta-${process.pid}`, `${process.env.HARNESS_INIT_META_MARKER}.events`);
    const initExitMarker = `${process.env.HARNESS_INIT_META_MARKER}.init-exit`;
    const invocation = runInitWithEnv({ PATH: pnpm.path, HARNESS_INIT_PREREQUISITE_TIMEOUT_MS: "60000" }, "--check");
    const pids = JSON.parse(await waitForFile(pnpm.marker));
    await atomicWriteFile(process.env.HARNESS_INIT_META_MARKER, JSON.stringify({
      worker_pid: process.pid,
      init_pid: pids.init,
      prerequisite_leader_pid: pids.leader,
      prerequisite_descendant_pid: pids.child,
      prerequisite_events: pnpm.events,
      init_exit_marker: initExitMarker,
    }));
    if (metaMode === "prerequisite-init") {
      const result = await invocation;
      await atomicWriteFile(initExitMarker, JSON.stringify({ code: result.code, signal: result.signal }));
      expect(result.code === 0 && result.signal === null, result.stderr).toBe(false);
      return;
    }
    await new Promise(() => {});
  });
});

describe.skipIf(!metaMode?.startsWith("phase-"))("test-worker phase barrier interruption fixture", () => {
  it("publishes an initializer blocked at the requested lifecycle phase", async () => {
    const phase = metaMode?.slice("phase-".length);
    const phaseMarker = `${process.env.HARNESS_INIT_META_MARKER}.phase`;
    const gate = `${process.env.HARNESS_INIT_META_MARKER}.gate`;
    const exitMarker = `${process.env.HARNESS_INIT_META_MARKER}.init-exit`;
    const invocation = runInitWithEnv({
      NODE_ENV: "test",
      HARNESS_INIT_TEST_PHASE: phase,
      HARNESS_INIT_TEST_PHASE_MARKER: phaseMarker,
      HARNESS_INIT_TEST_PHASE_GATE: gate,
    }, "--no-install");
    const published = JSON.parse(await waitForFile(phaseMarker));
    await atomicWriteFile(process.env.HARNESS_INIT_META_MARKER, JSON.stringify({
      worker_pid: process.pid,
      init_pid: published.pid,
      supervisor_pid: published.supervisor_pid,
      phase,
      state,
      init_exit_marker: exitMarker,
    }));
    const result = await invocation;
    await atomicWriteFile(exitMarker, JSON.stringify({ code: result.code, signal: result.signal }));
    expect(result.code === 0 && result.signal === null, result.stderr).toBe(false);
  });
});

describe.skipIf(metaMode !== "setup")("test-worker setup-failure cleanup fixture", () => {
  beforeAll(async () => {
    const result = await runInit("--no-install");
    expect(result.code, result.stderr).toBe(0);
    const instance = parseLastJson(result.stdout);
    await atomicWriteFile(process.env.HARNESS_INIT_META_MARKER, JSON.stringify({ worker_pid: process.pid, server_pid: instance.pid }));
    throw new Error("deliberate setup failure");
  });

  it("never reaches the test body", () => {});
});
