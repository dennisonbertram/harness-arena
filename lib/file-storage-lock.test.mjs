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

function startWorker({ lock, ready, gate, events, id, mode = "release", env = process.env }) {
  const child = spawn(process.execPath, ["scripts/tests/file-storage-lock-worker.mjs", lock, ready, gate, events, id, mode], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      children.delete(child);
      resolveExit({ code, signal, stderr });
    });
  });
  return { child, exited };
}

async function readOverlaps(events) {
  const active = new Set();
  const overlaps = [];
  const content = await readFile(events, "utf8").catch(() => "");
  for (const line of content.trim().split("\n").filter(Boolean)) {
    const [kind, id] = line.split(" ");
    if (kind === "enter") {
      if (active.size) overlaps.push([id, ...active]);
      active.add(id);
    } else active.delete(id);
  }
  return overlaps;
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

  it("never overlaps when a lower order key publishes after a higher claim has entered", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-arena-lock-late-lower-"));
    roots.push(root);
    const lock = join(root, "late-lower.lock");
    const ready = join(root, "ready");
    const gate = join(root, "go");
    const events = join(root, "events.log");
    const marker = join(root, "order-allocated");
    const publicationGate = join(root, "publish-lower");
    await mkdir(ready);
    const delayed = startWorker({
      lock, ready, gate, events, id: "lower", mode: "release",
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(resolve("scripts/tests/delay-claim-publication.mjs")).href}`,
        LOCK_TEST_AFTER_ORDER_MARKER: marker,
        LOCK_TEST_AFTER_ORDER_GATE: publicationGate,
      },
    });
    await waitForCount(ready, 1);
    await writeFile(gate, "go");
    await waitForText(marker, "order-allocated");

    const higher = startWorker({ lock, ready, gate, events, id: "higher", mode: "hold-gate" });
    await waitForText(events, "enter higher");
    await writeFile(publicationGate, "publish");
    await delay(150);
    const enteredWhileHigherHeld = (await readFile(events, "utf8")).includes("enter lower");
    await writeFile(`${gate}.release-higher`, "release");
    const [higherExit, delayedExit] = await Promise.all([higher.exited, delayed.exited]);

    expect({ enteredWhileHigherHeld, higherExit, delayedExit, overlaps: await readOverlaps(events) }).toEqual({
      enteredWhileHigherHeld: false,
      higherExit: { code: 0, signal: null, stderr: "" },
      delayedExit: { code: 0, signal: null, stderr: "" },
      overlaps: [],
    });
  }, 15_000);

  it("recovers after crashes at every claim and owner-fence publication phase", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-arena-lock-phase-crash-"));
    roots.push(root);
    for (const stage of ["afterOrderAllocated", "afterClaimPublished", "afterFencePrepared", "afterFencePublished"]) {
      const lock = join(root, `${stage}.lock`);
      const ready = join(root, `${stage}-ready`);
      const gate = join(root, `${stage}-go`);
      const events = join(root, `${stage}-events.log`);
      await mkdir(ready);
      const worker = startWorker({ lock, ready, gate, events, id: stage, mode: `crash:${stage}` });
      await waitForCount(ready, 1);
      await writeFile(gate, "go");
      await expect(worker.exited).resolves.toEqual({ code: null, signal: "SIGKILL", stderr: "" });
      const release = await acquireDirectoryLock(lock, { staleMs: 0, timeoutMs: 1_000, pollMs: 1 });
      await release();
    }
  }, 15_000);

  it("recovers concurrently after both the owner and a dead-fence reclaimer crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-arena-lock-recovery-crash-"));
    roots.push(root);
    const lock = join(root, "recovery.lock");
    const holderReady = join(root, "holder-ready");
    const holderGate = join(root, "holder-go");
    const holderEvents = join(root, "holder-events.log");
    await mkdir(holderReady);
    const holder = startWorker({ lock, ready: holderReady, gate: holderGate, events: holderEvents, id: "holder", mode: "hold" });
    await waitForCount(holderReady, 1);
    await writeFile(holderGate, "go");
    await waitForText(holderEvents, "enter holder");
    holder.child.kill("SIGKILL");
    await expect(holder.exited).resolves.toMatchObject({ signal: "SIGKILL" });

    const recoveryReady = join(root, "recovery-ready");
    const recoveryGate = join(root, "recovery-go");
    const recoveryEvents = join(root, "recovery-events.log");
    await mkdir(recoveryReady);
    const recovery = startWorker({ lock, ready: recoveryReady, gate: recoveryGate, events: recoveryEvents, id: "recovery", mode: "crash:afterDeadFencePinned" });
    await waitForCount(recoveryReady, 1);
    await writeFile(recoveryGate, "go");
    await expect(recovery.exited).resolves.toEqual({ code: null, signal: "SIGKILL", stderr: "" });

    const ready = join(root, "contender-ready");
    const gate = join(root, "contender-go");
    const events = join(root, "contender-events.log");
    await mkdir(ready);
    const contenders = Array.from({ length: 20 }, (_, index) => startWorker({ lock, ready, gate, events, id: String(index) }));
    await waitForCount(ready, contenders.length);
    await writeFile(gate, "go");
    const exits = await Promise.all(contenders.map((worker) => worker.exited));
    expect(exits).toEqual(Array.from({ length: contenders.length }, () => ({ code: 0, signal: null, stderr: "" })));
    expect(await readOverlaps(events)).toEqual([]);
  }, 30_000);

  it("removes only dead unique owner artifacts and requires the matching fence token to release", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-arena-lock-owner-token-"));
    roots.push(root);
    const lock = join(root, "token.lock");
    const staleOwner = `${lock}.99999999.stale.owner-candidate`;
    const staleRecovery = `${lock}.99999999.stale.recovery-pin`;
    const staleMetadata = JSON.stringify({ version: 3, pid: 99999999, token: "stale", created_at_ms: 1 });
    await writeFile(staleOwner, staleMetadata);
    await writeFile(staleRecovery, staleMetadata);

    const release = await acquireDirectoryLock(lock, { staleMs: 0, timeoutMs: 1_000, pollMs: 1 });
    await expect(stat(staleOwner)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(staleRecovery)).rejects.toMatchObject({ code: "ENOENT" });
    const fence = `${lock}.owner`;
    const current = JSON.parse(await readFile(fence, "utf8"));
    await rm(fence);
    await writeFile(fence, JSON.stringify({ ...current, token: "replacement-token" }), { mode: 0o600 });

    await expect(release()).rejects.toThrow(/ownership mismatch/);
    expect(JSON.parse(await readFile(fence, "utf8")).token).toBe("replacement-token");
  });
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
