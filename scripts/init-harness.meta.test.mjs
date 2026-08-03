import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const vitestBin = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(path, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await delay(20);
  }
  throw new Error(`timed out waiting for ${path}`);
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

function spawnFixture(mode, marker, preservationMarker) {
  const child = spawn(process.execPath, [
    vitestBin,
    "run",
    "scripts/init.integration.test.mjs",
    "--pool=forks",
    "--maxWorkers=1",
    "--no-file-parallelism",
    "--testNamePattern",
    mode === "setup" ? "test-worker setup-failure cleanup fixture" : "publishes a fake server",
  ], {
    cwd: repositoryRoot,
    detached: true,
    env: {
      ...process.env,
      HARNESS_INIT_META_MODE: mode,
      HARNESS_INIT_META_MARKER: marker,
      HARNESS_INIT_META_PRESERVATION_MARKER: preservationMarker,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal, output })));
  return { child, closed };
}

async function waitForClose(closed, timeoutMs = 10_000) {
  return Promise.race([closed, delay(timeoutMs).then(() => { throw new Error("fixture Vitest process did not exit"); })]);
}

describe.sequential("integration harness process cleanup", () => {
  it("SIGTERM of a forked test worker after publication leaves no fake-server descendant", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-arena-init-meta-signal-"));
    const marker = join(directory, "published.json");
    const preservationMarker = join(directory, "preserved.json");
    const fixture = spawnFixture("signal", marker, preservationMarker);
    let published;
    try {
      published = JSON.parse(await waitForFile(marker));
      expect(processExists(published.worker_pid)).toBe(true);
      expect(processExists(published.server_pid)).toBe(true);
      process.kill(published.worker_pid, "SIGTERM");
      await waitForGroupExit(published.server_pid, 5_000);
      expect(processExists(published.server_pid)).toBe(false);
      expect(JSON.parse(await waitForFile(preservationMarker))).toEqual({ preserved: true });
    } finally {
      if (published?.server_pid) await terminateGroup(published.server_pid);
      await terminateGroup(fixture.child.pid);
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it.each(["assertion", "setup"])("reaps the fake server and preserves both env files after deliberate %s failure", async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), `harness-arena-init-meta-${mode}-`));
    const marker = join(directory, "published.json");
    const preservationMarker = join(directory, "preserved.json");
    const fixture = spawnFixture(mode, marker, preservationMarker);
    let published;
    try {
      published = JSON.parse(await waitForFile(marker));
      const result = await waitForClose(fixture.closed);
      expect(result.code, result.output).not.toBe(0);
      await waitForGroupExit(published.server_pid, 5_000);
      expect(processExists(published.server_pid)).toBe(false);
      expect(JSON.parse(await waitForFile(preservationMarker))).toEqual({ preserved: true });
    } finally {
      if (published?.server_pid) await terminateGroup(published.server_pid);
      await terminateGroup(fixture.child.pid);
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
