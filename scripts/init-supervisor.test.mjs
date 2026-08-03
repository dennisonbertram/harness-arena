import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as init from "./init-lib.mjs";

const roots = [];
const looseChildren = new Set();
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

afterEach(async () => {
  for (const child of looseChildren) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
  looseChildren.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temp() {
  const root = await mkdtemp(join(tmpdir(), "harness-init-supervisor-"));
  roots.push(root);
  return root;
}

async function waitForJson(path, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for complete JSON at ${path}`);
}

async function waitForExit(child, timeoutMs = 3_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    delay(timeoutMs).then(() => { throw new Error(`process ${child.pid} did not exit`); }),
  ]);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function stubbornTreeScript() {
  return [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const marker = process.argv[1];",
    "process.on('SIGTERM', () => {});",
    "const descendant = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`], { stdio: 'ignore' });",
    "writeFileSync(marker, JSON.stringify({ command: process.pid, descendant: descendant.pid }));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
}

describe("authenticated prerequisite supervisor", () => {
  it("keeps a persistent group leader and reaps a TERM-resistant descendant tree", async () => {
    const root = await temp();
    const marker = join(root, "tree.json");
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", stubbornTreeScript(), marker], {
      cwd: root,
      env: { PATH: process.env.PATH },
      stdio: "ignore",
    });
    const tree = await waitForJson(marker);

    expect(owned.supervisorPid).not.toBe(tree.command);
    await expect(init.terminateOwnedSupervisor(owned, { graceMs: 40, killWaitMs: 2_000 })).resolves.toBe(true);
    await waitForExit(owned.child);
    expect(processAlive(owned.supervisorPid)).toBe(false);
    expect(processAlive(tree.command)).toBe(false);
    expect(processAlive(tree.descendant)).toBe(false);
  });

  it("never signals an injected, cloned, or already-exited ownership record", async () => {
    const root = await temp();
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    looseChildren.add(unrelated);
    await new Promise((resolveSpawn, rejectSpawn) => { unrelated.once("spawn", resolveSpawn); unrelated.once("error", rejectSpawn); });
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", "process.exit(0)"], { cwd: root, stdio: "ignore" });
    await owned.outcome;
    await waitForExit(owned.child);
    const signalGroup = vi.fn();

    await expect(init.terminateOwnedSupervisor({ ...owned, supervisorPid: unrelated.pid }, { signalGroup })).resolves.toBe(false);
    await expect(init.terminateOwnedSupervisor(owned, { signalGroup })).resolves.toBe(false);
    expect(signalGroup).not.toHaveBeenCalled();
    expect(processAlive(unrelated.pid)).toBe(true);
  });

  it("does not use a numeric PGID if the authenticated leader exits between TERM and escalation", async () => {
    const root = await temp();
    const marker = join(root, "tree.json");
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", stubbornTreeScript(), marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    const signalGroup = vi.fn();

    await expect(init.terminateOwnedSupervisor(owned, {
      graceMs: 1,
      signalGroup,
      beforeEscalate: async () => {
        owned.child.kill("SIGKILL");
        await waitForExit(owned.child);
      },
    })).resolves.toBe(false);
    expect(signalGroup).not.toHaveBeenCalled();
    for (const pid of [tree.command, tree.descendant]) { try { process.kill(pid, "SIGKILL"); } catch {} }
  });

  it("closes synchronous-spawn and pre-handshake cancellation races without publishing ownership", async () => {
    const syncSpawn = vi.fn(() => { throw Object.assign(new Error("injected sync spawn"), { code: "EACCES" }); });
    await expect(init.spawnSupervisedProcess("ignored", [], {}, { spawnImpl: syncSpawn })).rejects.toThrow(/injected sync spawn/);

    const controller = new AbortController();
    controller.abort(new Error("cancel before spawn"));
    const neverSpawn = vi.fn();
    await expect(init.spawnSupervisedProcess("ignored", [], {}, { spawnImpl: neverSpawn, signal: controller.signal })).rejects.toThrow(/cancel before spawn/);
    expect(neverSpawn).not.toHaveBeenCalled();
  });
});

describe("atomic init metadata publication", () => {
  it("keeps the previous complete record when publication is interrupted before rename", async () => {
    const root = await temp();
    const state = join(root, ".harness-arena");
    const original = { pid: 111, nonce: "original", port: 29991 };
    const replacement = { pid: 222, nonce: "replacement", port: 29992 };
    await init.writeInstanceMetadata(state, original);

    await expect(init.writeInstanceMetadata(state, replacement, {
      beforePublish: () => { throw new Error("injected metadata publication interruption"); },
    })).rejects.toThrow(/injected metadata publication interruption/);
    expect(JSON.parse(await readFile(join(state, "init.pid"), "utf8"))).toEqual(original);
  });
});
