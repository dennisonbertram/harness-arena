import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as locks from "./file-storage-lock.mjs";

const { acquireDirectoryLock } = locks;

const roots = [];
const children = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitForCount(path, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await readdir(path).then((entries) => entries.length).catch(() => 0);
    if (count === expected) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${expected} contenders`);
}

async function waitForText(path, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readFile(path, "utf8").catch(() => "");
    if (value.includes(expected)) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(expected)}`);
}

async function runRound(root, round, count = 20) {
  const lock = join(root, `shared-${round}.lock`);
  const ready = join(root, `ready-${round}`);
  const gate = join(root, `gate-${round}`);
  const events = join(root, `events-${round}.log`);
  await mkdir(lock, { recursive: true });
  await mkdir(ready, { recursive: true });
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 99999999, token: "stale", created_at_ms: 1 }));

  const exits = Array.from({ length: count }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/tests/file-storage-lock-worker.mjs", lock, ready, gate, events, String(index)], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
    children.add(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => {
      children.delete(child);
      if (code === 0) resolve(); else reject(new Error(`lock worker ${index} failed (${code}): ${stderr}`));
    });
    child.once("error", reject);
  }));
  await waitForCount(ready, count);
  await writeFile(gate, "go");
  await Promise.all(exits);

  const active = new Set();
  const overlaps = [];
  for (const line of (await readFile(events, "utf8")).trim().split("\n")) {
    const [kind, id] = line.split(" ");
    if (kind === "enter") {
      if (active.size) overlaps.push([id, ...active]);
      active.add(id);
    } else active.delete(id);
  }
  return { overlaps, active: [...active] };
}

describe("directory lock stale recovery", () => {
  it("keeps a contender paused before publication out of ownership even beyond the old grace", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-arena-lock-publish-"));
    roots.push(root);
    const lock = join(root, "delayed.lock");
    let announceHook;
    const hookReached = new Promise((resolve) => { announceHook = resolve; });
    let resumePublication;
    const publicationGate = new Promise((resolve) => { resumePublication = resolve; });
    let firstResolved = false;
    const first = acquireDirectoryLock(lock, {
      staleMs: 0,
      timeoutMs: 5_000,
      pollMs: 1,
      beforePublish: async () => { announceHook(); await publicationGate; },
    }).then((release) => { firstResolved = true; return release; });

    const initial = await Promise.race([
      hookReached.then(() => "hook"),
      first.then(() => "acquired"),
      delay(250).then(() => "timeout"),
    ]);
    if (initial !== "hook") {
      resumePublication();
      const release = await first;
      await release();
    }
    expect(initial).toBe("hook");

    const secondRelease = await acquireDirectoryLock(lock, { staleMs: 0, timeoutMs: 5_000, pollMs: 1 });
    await delay(1_100);
    resumePublication();
    await delay(50);
    expect(firstResolved).toBe(false);
    await secondRelease();
    const firstRelease = await first;
    await firstRelease();
  }, 10_000);

  it("self-heals after a holder crashes even when the old recovery directory is wedged", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-arena-lock-crash-"));
    roots.push(root);
    const lock = join(root, "crashed.lock");
    const ready = join(root, "ready");
    const gate = join(root, "gate");
    const events = join(root, "events.log");
    await mkdir(ready);
    const child = spawn(process.execPath, ["scripts/tests/file-storage-lock-worker.mjs", lock, ready, gate, events, "holder", "hold"], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
    children.add(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    await waitForCount(ready, 1);
    await writeFile(gate, "go");
    await waitForText(events, "enter holder");
    child.kill("SIGKILL");
    const exit = await exited;
    children.delete(child);
    expect(exit).toMatchObject({ signal: "SIGKILL" });
    expect(stderr).toBe("");

    const recovery = `${lock}.recovery`;
    await mkdir(recovery);
    await writeFile(join(recovery, "owner.json"), JSON.stringify({ pid: 99999999, token: "dead-recovery", created_at_ms: 1 }));
    const release = await acquireDirectoryLock(lock, { staleMs: 0, timeoutMs: 300, pollMs: 5 });
    await release();
  }, 10_000);

  it("serializes 20 contenders across repeated stale-lock ABA races", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-arena-lock-stress-"));
    roots.push(root);
    for (let round = 0; round < 5; round++) {
      await expect(runRound(root, round)).resolves.toEqual({ overlaps: [], active: [] });
    }
  }, 60_000);
});

describe("atomic no-overwrite publication", () => {
  it("keeps the final path absent on interruption, preserves mode, and never replaces an existing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-arena-exclusive-publish-"));
    roots.push(root);
    const target = join(root, "owner-only.json");
    expect(locks.atomicCreateFile).toBeTypeOf("function");

    await expect(locks.atomicCreateFile(target, "complete", 0o600, root, {
      beforePublish: async () => {
        await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        throw new Error("injected publication interruption");
      },
    })).rejects.toThrow(/injected publication interruption/);
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await locks.atomicCreateFile(target, "complete", 0o600, root);
    expect(await readFile(target, "utf8")).toBe("complete");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    await expect(locks.atomicCreateFile(target, "replacement", 0o600, root)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(target, "utf8")).toBe("complete");
  });

  it("recovers after a writer crashes between temp fsync and final publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-arena-exclusive-crash-"));
    roots.push(root);
    const target = join(root, "seed.json");
    const worker = join(root, "crash-writer.mjs");
    const moduleUrl = pathToFileURL(resolve("lib/file-storage-lock.mjs")).href;
    await writeFile(worker, [
      `import { atomicCreateFile } from ${JSON.stringify(moduleUrl)};`,
      `await atomicCreateFile(${JSON.stringify(target)}, "complete", 0o600, ${JSON.stringify(root)}, {`,
      "  beforePublish: () => process.kill(process.pid, 'SIGKILL'),",
      "});",
    ].join("\n"));
    const child = spawn(process.execPath, [worker], { stdio: "ignore" });
    children.add(child);
    const exit = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    children.delete(child);
    expect(exit).toEqual({ code: null, signal: "SIGKILL" });
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await locks.atomicCreateFile(target, "complete", 0o600, root);
    expect(await readFile(target, "utf8")).toBe("complete");
  });
});
