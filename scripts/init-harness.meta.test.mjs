import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configuredSecrets, redactOpsText } from "../lib/ops-redaction.mjs";

const repositoryRoot = process.cwd();
const vitestBin = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const FIXTURE_OUTPUT_MAX_BYTES = 16 * 1024;
const FIXTURE_OUTPUT_TRUNCATED = "\n[output truncated]";
const FIXTURE_PUBLICATION_BASE_MS = 10_000;
const FIXTURE_PUBLICATION_MAX_MS = 25_000;

function fixturePublicationDeadlineMs(schedulingDelayMs, maximumMs = FIXTURE_PUBLICATION_MAX_MS) {
  if (!Number.isFinite(schedulingDelayMs) || schedulingDelayMs < 0) throw new Error("fixture scheduling delay must be a non-negative finite number");
  if (!Number.isFinite(maximumMs) || maximumMs <= 0) throw new Error("fixture publication cap must be a positive finite number");
  return Math.min(FIXTURE_PUBLICATION_BASE_MS + schedulingDelayMs, maximumMs);
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function truncateUtf8(value, maximumBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function createFixtureOutputCapture(secrets) {
  const chunks = [];
  let capturedBytes = 0;
  let truncated = false;
  return {
    append(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = FIXTURE_OUTPUT_MAX_BYTES - capturedBytes;
      if (remaining > 0) {
        const retained = bytes.subarray(0, remaining);
        chunks.push(retained);
        capturedBytes += retained.length;
      }
      if (bytes.length > remaining) truncated = true;
    },
    read() {
      let retained = Buffer.concat(chunks, capturedBytes);
      if (truncated) {
        // A configured secret may cross the byte cap. Drop enough retained
        // tail bytes that no proper secret prefix can survive at the boundary;
        // complete secrets in the remaining prefix are redacted below.
        const boundaryBytes = secrets.reduce((maximum, secret) => Math.max(maximum, Buffer.byteLength(secret, "utf8") - 1), 0);
        retained = retained.subarray(0, Math.max(0, retained.length - Math.min(boundaryBytes, retained.length)));
      }
      const raw = retained.toString("utf8");
      let safe = redactOpsText(raw, secrets);
      const needsMarker = truncated || Buffer.byteLength(safe, "utf8") > FIXTURE_OUTPUT_MAX_BYTES;
      if (!needsMarker) return safe;
      const budget = FIXTURE_OUTPUT_MAX_BYTES - Buffer.byteLength(FIXTURE_OUTPUT_TRUNCATED, "utf8");
      safe = truncateUtf8(safe, budget);
      return `${safe}${FIXTURE_OUTPUT_TRUNCATED}`;
    },
  };
}

function fixtureDiagnostic(fixture, result) {
  const output = result?.output ?? fixture?.output?.().trim() ?? "";
  const code = result ? result.code : "running";
  const signal = result ? result.signal : null;
  return `; fixture=${fixture?.mode ?? "unknown"}; code=${code}; signal=${signal}; child output=${JSON.stringify(output)}`;
}

async function waitForFile(path, timeoutMs = 10_000, fixture) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(path, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    const remaining = Math.max(0, deadline - Date.now());
    const outcome = await Promise.race([
      fixture?.closed?.then((result) => ({ kind: "closed", result })),
      delay(Math.min(20, remaining)).then(() => ({ kind: "poll" })),
    ].filter(Boolean));
    if (outcome?.kind !== "closed") continue;
    try { return await readFile(path, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    throw new Error(`fixture exited before publication blocker ${path}${fixtureDiagnostic(fixture, outcome.result)}`);
  }
  throw new Error(`publication deadline exceeded after ${timeoutMs}ms; blocker=${path}${fixtureDiagnostic(fixture)}`);
}

async function waitForGroupExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); } catch (error) { if (error?.code !== "EPERM") return; }
    await delay(25);
  }
  throw new Error(`process group ${pid} survived cleanup`);
}

async function terminateGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, "SIGTERM"); } catch {}
  try { await waitForGroupExit(pid, 1_000); return; } catch {}
  try { process.kill(-pid, "SIGKILL"); } catch {}
  await waitForGroupExit(pid).catch(() => {});
}

function processTree(rootPid) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map();
  for (const line of result.stdout.trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    const siblings = children.get(ppid) ?? [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }
  const found = [rootPid];
  for (let index = 0; index < found.length; index += 1) found.push(...(children.get(found[index]) ?? []));
  return found;
}

function spawnFixture(mode, marker, preservationMarker, { env: configuredEnv = {}, outputBytes = 0 } = {}) {
  const testNamePattern = mode.startsWith("prerequisite-")
    ? "publishes a hung prerequisite"
    : mode.startsWith("phase-")
      ? "publishes an initializer blocked"
      : mode === "publication-delay"
        ? "delays fixture publication"
      : mode === "setup"
      ? "test-worker setup-failure cleanup fixture"
      : "publishes a fake server";
  const childEnv = {
    ...process.env,
    ...configuredEnv,
    HARNESS_INIT_META_MODE: mode,
    HARNESS_INIT_META_MARKER: marker,
    HARNESS_INIT_META_PRESERVATION_MARKER: preservationMarker,
  };
  if (mode === "publication-delay") childEnv.HARNESS_INIT_META_PUBLICATION_DELAY_MS = "10100";
  let childArgs = [
    vitestBin, "run", "scripts/init.integration.test.mjs",
    "--pool=forks", "--maxWorkers=1", "--no-file-parallelism", "--testNamePattern", testNamePattern,
  ];
  if (mode === "immediate-exit") {
    childEnv.HARNESS_META_OUTPUT_BYTES = String(outputBytes);
    childArgs = ["-e", [
      "const outputBytes = Number(process.env.HARNESS_META_OUTPUT_BYTES || 0);",
      "process.stderr.write(`${process.env.LOCAL_INSTANCE_NONCE || ''}\\n${process.env.HARNESS_META_CONFIG_TOKEN || ''}\\n${'x'.repeat(outputBytes)}`);",
      "process.exit(17);",
    ].join("\n")];
  } else if (mode === "never-publish") {
    childArgs = ["-e", "setInterval(() => {}, 1000)"];
  }
  const child = spawn(process.execPath, childArgs, {
    cwd: repositoryRoot,
    detached: true,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const secrets = configuredSecrets(childEnv);
  const output = createFixtureOutputCapture(secrets);
  child.stdout.on("data", (chunk) => { output.append(chunk); });
  child.stderr.on("data", (chunk) => { output.append(chunk); });
  let spawnError;
  child.once("error", (error) => { spawnError = error; });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({
    code,
    signal,
    output: output.read(),
    error: spawnError ? redactOpsText(spawnError.message, secrets) : undefined,
  })));
  return { child, closed, mode, output: () => output.read() };
}

async function waitForClose(closed, timeoutMs = 10_000, fixture) {
  return Promise.race([closed, delay(timeoutMs).then(() => { throw new Error(`fixture Vitest process did not exit${fixtureDiagnostic(fixture)}`); })]);
}

async function waitForText(path, expected, timeoutMs = 5_000, fixture) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readFile(path, "utf8").catch(() => "");
    if (expected.every((item) => value.includes(item))) return value;
    await delay(20);
  }
  throw new Error(`timed out waiting for phase blocker ${expected.join(", ")} in ${path}${fixtureDiagnostic(fixture)}`);
}

describe.sequential("integration harness process cleanup", () => {
  it("fails promptly on immediate fixture exit with redacted, capped child output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-arena-init-meta-immediate-exit-"));
    const marker = join(directory, "published.json");
    const inheritedSecret = "meta-inherited-secret-sentinel";
    const configuredSecret = "meta-configured-token-sentinel";
    process.env.LOCAL_INSTANCE_NONCE = inheritedSecret;
    const fixture = spawnFixture("immediate-exit", marker, join(directory, "preserved.json"), {
      env: { HARNESS_META_CONFIG_TOKEN: configuredSecret },
      outputBytes: FIXTURE_OUTPUT_MAX_BYTES * 2,
    });
    const started = Date.now();
    try {
      const failure = await waitForFile(marker, 1_000, fixture).then(() => null, (error) => error);
      expect(Date.now() - started).toBeLessThan(750);
      expect(failure?.message).toMatch(/code=17.*signal=null/);
      expect(failure?.message).not.toContain(inheritedSecret);
      expect(failure?.message).not.toContain(configuredSecret);
      expect(failure?.message).toContain("[REDACTED]");
      expect(Buffer.byteLength(fixture.output(), "utf8")).toBeLessThanOrEqual(FIXTURE_OUTPUT_MAX_BYTES);
      expect(fixture.output()).toContain("[output truncated]");
    } finally {
      delete process.env.LOCAL_INSTANCE_NONCE;
      await terminateGroup(fixture.child.pid);
      await rm(directory, { recursive: true, force: true });
    }
  }, 5_000);

  it("caps a derived publication deadline and bounds a hung never-publisher", async () => {
    expect(fixturePublicationDeadlineMs(100_000)).toBe(FIXTURE_PUBLICATION_MAX_MS);
    const deadlineMs = fixturePublicationDeadlineMs(100_000, 200);
    expect(deadlineMs).toBe(200);
    const directory = await mkdtemp(join(tmpdir(), "harness-arena-init-meta-never-publish-"));
    const marker = join(directory, "published.json");
    const fixture = spawnFixture("never-publish", marker, join(directory, "preserved.json"));
    const started = Date.now();
    try {
      const failure = await waitForFile(marker, deadlineMs, fixture).then(() => null, (error) => error);
      expect(Date.now() - started).toBeGreaterThanOrEqual(150);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(failure?.message).toMatch(/publication deadline.*never-publish/);
    } finally {
      await terminateGroup(fixture.child.pid);
      await rm(directory, { recursive: true, force: true });
    }
  }, 5_000);

  it("derives the fixture publication deadline from an allowed scheduling delay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-arena-init-meta-publication-delay-"));
    const marker = join(directory, "published.json");
    const fixture = spawnFixture("publication-delay", marker, join(directory, "preserved.json"));
    try {
      expect(JSON.parse(await waitForFile(marker, fixturePublicationDeadlineMs(10_100), fixture))).toEqual({ worker_pid: expect.any(Number) });
    } finally {
      await terminateGroup(fixture.child.pid);
      await rm(directory, { recursive: true, force: true });
    }
  }, fixturePublicationDeadlineMs(10_100) + 5_000);

  it("SIGTERM of a forked test worker after publication leaves no fake-server descendant", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-arena-init-meta-signal-"));
    const marker = join(directory, "published.json");
    const preservationMarker = join(directory, "preserved.json");
    const fixture = spawnFixture("signal", marker, preservationMarker);
    let published;
    try {
      published = JSON.parse(await waitForFile(marker, undefined, fixture));
      expect(processExists(published.worker_pid)).toBe(true);
      expect(processExists(published.server_pid)).toBe(true);
      process.kill(published.worker_pid, "SIGTERM");
      await waitForGroupExit(published.server_pid, 5_000);
      expect(processExists(published.server_pid)).toBe(false);
      expect(JSON.parse(await waitForFile(preservationMarker, undefined, fixture))).toEqual({ preserved: true });
    } finally {
      if (published?.server_pid) await terminateGroup(published.server_pid);
      await terminateGroup(fixture.child.pid);
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it.each(["normal", "assertion", "setup"])("reaps the fake server and preserves both env files after %s worker exit", async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), `harness-arena-init-meta-${mode}-`));
    const marker = join(directory, "published.json");
    const preservationMarker = join(directory, "preserved.json");
    const fixture = spawnFixture(mode, marker, preservationMarker);
    let published;
    try {
      published = JSON.parse(await waitForFile(marker, undefined, fixture));
      const result = await waitForClose(fixture.closed, undefined, fixture);
      if (mode === "normal") expect(result.code, result.output).toBe(0);
      else expect(result.code, result.output).not.toBe(0);
      await waitForGroupExit(published.server_pid, 5_000);
      expect(processExists(published.server_pid)).toBe(false);
      expect(JSON.parse(await waitForFile(preservationMarker, undefined, fixture))).toEqual({ preserved: true });
    } finally {
      if (published?.server_pid) await terminateGroup(published.server_pid);
      await terminateGroup(fixture.child.pid);
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it.each([
    { name: "SIGINT", target: "worker", signals: ["SIGINT"] },
    { name: "SIGTERM", target: "worker", signals: ["SIGTERM"] },
    { name: "SIGINT", target: "init", signals: ["SIGINT"] },
    { name: "SIGTERM", target: "init", signals: ["SIGTERM"] },
    { name: "concurrent SIGINT/SIGTERM", target: "init", signals: ["SIGINT", "SIGTERM"] },
  ])("$name interruption of the $target during a hung prerequisite reaps every published process", async ({ target, signals }) => {
    const directory = await mkdtemp(join(tmpdir(), `harness-arena-init-meta-prerequisite-${target}-${signals.join("-").toLowerCase()}-`));
    const marker = join(directory, "published.json");
    const preservationMarker = join(directory, "preserved.json");
    const fixture = spawnFixture(`prerequisite-${target}`, marker, preservationMarker);
    let published;
    try {
      published = JSON.parse(await waitForFile(marker, undefined, fixture));
      for (const pid of [published.worker_pid, published.init_pid, published.prerequisite_leader_pid, published.prerequisite_descendant_pid]) {
        expect(processExists(pid), `expected published process ${pid} to be alive`).toBe(true);
      }
      const started = Date.now();
      for (const signal of signals) process.kill(target === "worker" ? published.worker_pid : published.init_pid, signal);
      const result = await waitForClose(fixture.closed, 10_000, fixture);
      expect(Date.now() - started).toBeLessThan(5_000);
      if (target === "worker") expect(result.code, result.output).not.toBe(0);
      else {
        const exit = JSON.parse(await waitForFile(published.init_exit_marker, undefined, fixture));
        expect(exit.code).toBeNull();
        expect(signals).toContain(exit.signal);
      }
      await waitForGroupExit(published.init_pid, 2_500);
      await waitForGroupExit(published.prerequisite_leader_pid, 2_500);
      for (const pid of [published.init_pid, published.prerequisite_leader_pid, published.prerequisite_descendant_pid]) {
        expect(processExists(pid), `published process ${pid} survived ${signals.join("/")}`).toBe(false);
      }
      expect(await waitForText(published.prerequisite_events, ["leader:SIGTERM", "descendant:SIGTERM"], undefined, fixture)).toContain("descendant:ready");
      expect(JSON.parse(await waitForFile(preservationMarker, undefined, fixture))).toEqual({ preserved: true });
      await waitForGroupExit(fixture.child.pid, 2_500);
    } finally {
      if (published?.prerequisite_leader_pid) await terminateGroup(published.prerequisite_leader_pid);
      if (published?.init_pid) await terminateGroup(published.init_pid);
      await terminateGroup(fixture.child.pid);
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);

  it.each([
    { name: "SIGINT", target: "worker", signals: ["SIGINT"] },
    { name: "SIGTERM", target: "worker", signals: ["SIGTERM"] },
    { name: "SIGINT", target: "init", signals: ["SIGINT"] },
    { name: "SIGTERM", target: "init", signals: ["SIGTERM"] },
    { name: "concurrent SIGINT/SIGTERM", target: "init", signals: ["SIGINT", "SIGTERM"] },
  ])("$name interruption of the $target during authenticated durable detach reaps the complete server tree", async ({ target, signals }) => {
    const directory = await mkdtemp(join(tmpdir(), `harness-arena-init-meta-detach-${target}-${signals.join("-").toLowerCase()}-`));
    const marker = join(directory, "published.json");
    const preservationMarker = join(directory, "preserved.json");
    const fixture = spawnFixture("phase-durable_detach", marker, preservationMarker);
    let published;
    try {
      published = JSON.parse(await waitForFile(marker, 5_000, fixture));
      const serverTree = processTree(published.supervisor_pid);
      expect(serverTree.length).toBeGreaterThanOrEqual(4);
      for (const pid of [published.worker_pid, published.init_pid, ...serverTree]) expect(processExists(pid), `expected ${pid} alive at detach barrier`).toBe(true);
      for (const signal of signals) process.kill(target === "worker" ? published.worker_pid : published.init_pid, signal);
      const result = await waitForClose(fixture.closed, 10_000, fixture);
      if (target === "worker") expect(result.code, result.output).not.toBe(0);
      else {
        const exit = JSON.parse(await waitForFile(published.init_exit_marker, undefined, fixture));
        expect(exit.code).toBeNull();
        expect(signals).toContain(exit.signal);
      }
      await waitForGroupExit(published.init_pid, 2_500);
      await waitForGroupExit(published.supervisor_pid, 2_500);
      for (const pid of [published.init_pid, ...serverTree]) expect(processExists(pid), `process ${pid} survived detach interruption`).toBe(false);
      await expect(readFile(join(published.state, "init.lock.owner"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(published.state, "init.pid"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await waitForFile(preservationMarker, undefined, fixture))).toEqual({ preserved: true });
    } finally {
      if (published?.supervisor_pid) await terminateGroup(published.supervisor_pid);
      if (published?.init_pid) await terminateGroup(published.init_pid);
      await terminateGroup(fixture.child.pid);
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);

  it.each([
    "lock_wait",
    "active_prerequisite",
    "pre_server_spawn",
    "ownership_handshake",
    "readiness_poll",
    "server_lifecycle",
    "durable_detach",
  ])("SIGTERM at the %s phase barrier cleans owned processes and releases the init lock", async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), `harness-arena-init-meta-phase-${phase}-`));
    const marker = join(directory, "published.json");
    const preservationMarker = join(directory, "preserved.json");
    const fixture = spawnFixture(`phase-${phase}`, marker, preservationMarker);
    let published;
    try {
      published = JSON.parse(await waitForFile(marker, undefined, fixture));
      expect(published).toMatchObject({ phase, init_pid: expect.any(Number) });
      process.kill(published.init_pid, "SIGTERM");
      const result = await waitForClose(fixture.closed, 10_000, fixture);
      expect(result.code, result.output).toBe(0);
      expect(JSON.parse(await waitForFile(published.init_exit_marker, undefined, fixture))).toEqual({ code: null, signal: "SIGTERM" });
      await waitForGroupExit(published.init_pid, 2_500);
      if (published.supervisor_pid) await waitForGroupExit(published.supervisor_pid, 2_500);
      await expect(readFile(join(published.state, "init.lock.owner"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await waitForFile(preservationMarker, undefined, fixture))).toEqual({ preserved: true });
    } finally {
      if (published?.supervisor_pid) await terminateGroup(published.supervisor_pid);
      if (published?.init_pid) await terminateGroup(published.init_pid);
      await terminateGroup(fixture.child.pid);
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);
});
