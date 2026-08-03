import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as init from "./init-lib.mjs";

const roots = [];
const looseChildren = new Set();
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

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

function processGroupId(pid) {
  const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
  const pgid = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isSafeInteger(pgid) || pgid <= 0) throw new Error(`missing process group for ${pid}`);
  return pgid;
}

async function waitForGone(pids, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processAlive(pid))) return;
    await delay(10);
  }
  throw new Error(`processes survived cleanup: ${pids.filter(processAlive).join(", ")}`);
}

async function forceCleanup(owned, pids = []) {
  const groups = new Set();
  for (const pid of pids) {
    try { groups.add(processGroupId(pid)); } catch {}
  }
  for (const pgid of groups) { try { process.kill(-pgid, "SIGKILL"); } catch {} }
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  try { owned?.child.kill("SIGKILL"); } catch {}
  if (owned?.child) await waitForExit(owned.child).catch(() => {});
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
    const commandGroup = processGroupId(tree.command);
    try {
      expect(owned.supervisorPid).not.toBe(tree.command);
      expect(commandGroup).not.toBe(owned.supervisorPid);
      expect(processAlive(commandGroup)).toBe(true);
      await expect(init.terminateOwnedSupervisor(owned, { graceMs: 40, killWaitMs: 2_000 })).resolves.toBe(true);
      await waitForExit(owned.child);
      expect(processAlive(owned.supervisorPid)).toBe(false);
      expect(processAlive(tree.command)).toBe(false);
      expect(processAlive(tree.descendant)).toBe(false);
    } finally { await forceCleanup(owned, [tree.command, tree.descendant]); }
  });

  it("always reaps an unref descendant when the authenticated parent disconnects after command outcome", async () => {
    const root = await temp();
    const marker = join(root, "disconnect-after.json");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const descendant = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`], { stdio: 'ignore' });",
      "descendant.unref();",
      "writeFileSync(process.argv[1], JSON.stringify({ command: process.pid, descendant: descendant.pid }));",
    ].join("\n");
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", script, marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    try {
      await expect(owned.outcome).resolves.toMatchObject({ code: 0, signal: null });
      expect(processAlive(tree.descendant)).toBe(true);
      owned.child.disconnect();
      await waitForExit(owned.child);
      await waitForGone([tree.descendant]);
    } finally { await forceCleanup(owned, [tree.descendant]); }
  });

  it("always reaps the live leader and descendant when the parent disconnects before outcome", async () => {
    const root = await temp();
    const marker = join(root, "disconnect-before.json");
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", stubbornTreeScript(), marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    try {
      owned.child.disconnect();
      await waitForExit(owned.child);
      await waitForGone([tree.command, tree.descendant]);
    } finally { await forceCleanup(owned, [tree.command, tree.descendant]); }
  });

  it("stays group leader after the direct command exits until orphan descendants are reaped", async () => {
    const root = await temp();
    const marker = join(root, "orphan.json");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const descendant = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`], { stdio: 'ignore' });",
      "descendant.unref();",
      "writeFileSync(process.argv[1], JSON.stringify({ descendant: descendant.pid }));",
    ].join("\n");
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", script, marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    await expect(owned.outcome).resolves.toMatchObject({ code: 0, signal: null });
    expect(processAlive(owned.supervisorPid)).toBe(true);
    expect(processAlive(tree.descendant)).toBe(true);

    await expect(init.terminateOwnedSupervisor(owned, { graceMs: 40, killWaitMs: 2_000 })).resolves.toBe(true);
    expect(processAlive(tree.descendant)).toBe(false);
  });

  it("never signals an injected, cloned, or already-exited ownership record", async () => {
    const root = await temp();
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    looseChildren.add(unrelated);
    await new Promise((resolveSpawn, rejectSpawn) => { unrelated.once("spawn", resolveSpawn); unrelated.once("error", rejectSpawn); });
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", "process.exit(0)"], { cwd: root, stdio: "ignore" });
    await owned.outcome;
    await init.terminateOwnedSupervisor(owned, { graceMs: 20 });
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

  it("fails closed when the inner group leader exits between TERM and KILL", async () => {
    const root = await temp();
    const marker = join(root, "leader-race.json");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const descendant = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
      "process.on('SIGTERM', () => { try { process.kill(process.ppid, 'SIGKILL'); } catch {} });",
      "descendant.once('message', () => writeFileSync(process.argv[1], JSON.stringify({ command: process.pid, descendant: descendant.pid })));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", script, marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    try {
      await expect(init.terminateOwnedSupervisor(owned, { graceMs: 200, killWaitMs: 250 })).resolves.toBe(false);
      expect(processAlive(tree.descendant)).toBe(true);
    } finally { await forceCleanup(owned, [tree.command, tree.descendant]); }
  });

  it.each(["missing", "spoofed"])("requires a valid group-reaped acknowledgement when it is %s", async (mode) => {
    const root = await temp();
    const marker = join(root, `ack-${mode}.json`);
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", stubbornTreeScript(), marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    const emit = owned.child.emit;
    owned.child.emit = function filteredEmit(event, ...args) {
      if (event !== "message" || args[0]?.type !== "group-reaped") return emit.call(this, event, ...args);
      if (mode === "missing") return false;
      return emit.call(this, event, { ...args[0], nonce: "spoofed-nonce" }, ...args.slice(1));
    };
    try {
      await expect(init.terminateOwnedSupervisor(owned, { graceMs: 40, killWaitMs: 250 })).resolves.toBe(false);
      await waitForGone([tree.command, tree.descendant]);
    } finally {
      owned.child.emit = emit;
      await forceCleanup(owned, [tree.command, tree.descendant]);
    }
  });

  it("never asks the parent to signal a bare group id and reaps three default trees in parallel", async () => {
    const signalGroup = vi.fn();
    const runs = await Promise.all(Array.from({ length: 3 }, async (_, index) => {
      const root = await temp();
      const marker = join(root, `parallel-${index}.json`);
      const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", stubbornTreeScript(), marker], { cwd: root, stdio: "ignore" });
      const tree = await waitForJson(marker);
      try {
        const terminated = await init.terminateOwnedSupervisor(owned, { signalGroup });
        await waitForExit(owned.child);
        return { terminated, tree };
      } finally { await forceCleanup(owned, [tree.command, tree.descendant]); }
    }));
    expect(runs.every(({ terminated }) => terminated)).toBe(true);
    for (const { tree } of runs) expect([tree.command, tree.descendant].every((pid) => !processAlive(pid))).toBe(true);
    expect(signalGroup).not.toHaveBeenCalled();
  });

  it("aborts and reaps when cancellation wins just before the authenticated detach acknowledgement", async () => {
    const root = await temp();
    const marker = join(root, "detach-before-ack.json");
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", stubbornTreeScript(), marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    const controller = new AbortController();
    const observed = deferred();
    let held;
    const emit = owned.child.emit;
    owned.child.emit = function holdDetachAck(event, ...args) {
      if (event === "message" && ["detach-prepared", "detached"].includes(args[0]?.type)) {
        held = args;
        observed.resolve();
        return false;
      }
      return emit.call(this, event, ...args);
    };
    try {
      const detaching = init.detachOwnedSupervisor(owned, { signal: controller.signal });
      await observed.promise;
      controller.abort(new Error("cancel before detach ack"));
      emit.call(owned.child, "message", ...held);
      await expect(detaching).rejects.toThrow(/cancel before detach ack/);
      await waitForExit(owned.child);
      await waitForGone([tree.command, tree.descendant]);
    } finally {
      owned.child.emit = emit;
      await forceCleanup(owned, [tree.command, tree.descendant]);
    }
  });

  it("reaps the exact reviewer repro when the anchor dies after prepare and before explicit commit", async () => {
    const root = await temp();
    const marker = join(root, "detach-anchor-dies-after-prepare.json");
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", stubbornTreeScript(), marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    const anchorPid = processGroupId(tree.command);
    try {
      await expect(init.detachOwnedSupervisor(owned, {
        beforeCommit: async () => {
          process.kill(anchorPid, "SIGKILL");
          await waitForGone([anchorPid]);
        },
      })).resolves.toBe(false);
      await waitForExit(owned.child);
      await waitForGone([tree.command, tree.descendant]);
    } finally { await forceCleanup(owned, [tree.command, tree.descendant]); }
  });

  it("reaps when cancellation wins after prepare and before the explicit commit request", async () => {
    const root = await temp();
    const marker = join(root, "detach-after-prepare.json");
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", stubbornTreeScript(), marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    const controller = new AbortController();
    const entered = deferred();
    const release = deferred();
    try {
      const detaching = init.detachOwnedSupervisor(owned, {
        signal: controller.signal,
        beforeCommit: async () => { entered.resolve(); await release.promise; },
      });
      await Promise.race([entered.promise, delay(1_000).then(() => { throw new Error("prepare barrier was not entered"); })]);
      controller.abort(new Error("cancel after prepare"));
      release.resolve();
      await expect(detaching).rejects.toThrow(/cancel after prepare/);
      await waitForExit(owned.child);
      await waitForGone([tree.command, tree.descendant]);
    } finally { await forceCleanup(owned, [tree.command, tree.descendant]); }
  });

  it("reaps when the anchor dies after the commit request and before its final acknowledgement", async () => {
    const root = await temp();
    const marker = join(root, "detach-anchor-dies-during-commit.json");
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", stubbornTreeScript(), marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    const anchorPid = processGroupId(tree.command);
    const originalSend = owned.child.send;
    let killed = false;
    owned.child.send = function killAnchorBeforeCommitDelivery(message, ...args) {
      if (message?.type === "commit-detach" && !killed) {
        killed = true;
        process.kill(anchorPid, "SIGKILL");
      }
      return originalSend.call(this, message, ...args);
    };
    try {
      await expect(init.detachOwnedSupervisor(owned)).resolves.toBe(false);
      expect(killed).toBe(true);
      await waitForExit(owned.child);
      await waitForGone([tree.command, tree.descendant]);
    } finally {
      owned.child.send = originalSend;
      await forceCleanup(owned, [tree.command, tree.descendant]);
    }
  });

  it("reaps when cancellation wins after commit but before the final commit acknowledgement", async () => {
    const root = await temp();
    const marker = join(root, "detach-before-final-ack.json");
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", stubbornTreeScript(), marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    const controller = new AbortController();
    const observed = deferred();
    let held;
    const emit = owned.child.emit;
    owned.child.emit = function holdFinalCommitAck(event, ...args) {
      if (event === "message" && args[0]?.type === "detach-committed") {
        held = args;
        observed.resolve();
        return false;
      }
      return emit.call(this, event, ...args);
    };
    try {
      const detaching = init.detachOwnedSupervisor(owned, { signal: controller.signal });
      await Promise.race([observed.promise, delay(1_000).then(() => { throw new Error("final commit acknowledgement was not observed"); })]);
      controller.abort(new Error("cancel before final commit ack"));
      emit.call(owned.child, "message", ...held);
      await expect(detaching).rejects.toThrow(/cancel before final commit ack/);
      await waitForExit(owned.child);
      await waitForGone([tree.command, tree.descendant]);
    } finally {
      owned.child.emit = emit;
      await forceCleanup(owned, [tree.command, tree.descendant]);
    }
  });

  it("chains repeated cleanup after final commit ACK when cancellation wins before disconnect", async () => {
    const root = await temp();
    const marker = join(root, "detach-after-ack.json");
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", stubbornTreeScript(), marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    const controller = new AbortController();
    const entered = deferred();
    const release = deferred();
    try {
      const detaching = init.detachOwnedSupervisor(owned, {
        signal: controller.signal,
        beforeDisconnect: async () => { entered.resolve(); await release.promise; },
      });
      await Promise.race([entered.promise, delay(1_000).then(() => { throw new Error("detach barrier was not entered"); })]);
      controller.abort(new Error("cancel after final commit ack"));
      const repeated = [init.terminateOwnedSupervisor(owned), init.terminateOwnedSupervisor(owned)];
      release.resolve();
      await expect(detaching).rejects.toThrow(/cancel after final commit ack/);
      await expect(Promise.all(repeated)).resolves.toEqual([true, true]);
      await waitForExit(owned.child);
      await waitForGone([tree.command, tree.descendant]);
    } finally { await forceCleanup(owned, [tree.command, tree.descendant]); }
  });

  it.each([
    ["prepared", "missing"],
    ["prepared", "spoofed"],
    ["committed", "missing"],
    ["committed", "spoofed"],
  ])("reaps before returning false when the %s acknowledgement is %s", async (phase, mode) => {
    const root = await temp();
    const marker = join(root, `detach-${phase}-${mode}.json`);
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", stubbornTreeScript(), marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    const emit = owned.child.emit;
    owned.child.emit = function filterDetachAck(event, ...args) {
      const expectedType = phase === "prepared" ? "detach-prepared" : "detach-committed";
      const oldSinglePhaseAck = phase === "prepared" && args[0]?.type === "detached";
      if (event !== "message" || (args[0]?.type !== expectedType && !oldSinglePhaseAck)) return emit.call(this, event, ...args);
      if (mode === "missing") return false;
      return emit.call(this, event, { ...args[0], detachId: "spoofed-detach-id" }, ...args.slice(1));
    };
    try {
      await expect(init.detachOwnedSupervisor(owned)).resolves.toBe(false);
      await waitForExit(owned.child);
      await waitForGone([tree.command, tree.descendant]);
    } finally {
      owned.child.emit = emit;
      await forceCleanup(owned, [tree.command, tree.descendant]);
    }
  });

  it("ignores replayed and out-of-order authenticated detach acknowledgements", async () => {
    const root = await temp();
    const marker = join(root, "detach-ack-order.json");
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", stubbornTreeScript(), marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    const groupPid = processGroupId(tree.command);
    const originalSend = owned.child.send;
    const sent = [];
    owned.child.send = function injectOutOfOrder(message, ...args) {
      sent.push(message);
      const result = originalSend.call(this, message, ...args);
      if (message?.type === "detach") {
        queueMicrotask(() => owned.child.emit("message", {
          type: "detach-committed",
          nonce: message.nonce,
          supervisorPid: owned.supervisorPid,
          groupPid,
          detachId: message.detachId,
        }));
      } else if (message?.type === "commit-detach") {
        queueMicrotask(() => owned.child.emit("message", {
          type: "detach-prepared",
          nonce: message.nonce,
          supervisorPid: owned.supervisorPid,
          groupPid,
          detachId: message.detachId,
        }));
      }
      return result;
    };
    try {
      await expect(init.detachOwnedSupervisor(owned)).resolves.toBe(true);
      expect(sent.map(({ type }) => type)).toEqual(expect.arrayContaining(["detach", "commit-detach"]));
      expect(sent.find(({ type }) => type === "detach").detachId)
        .toBe(sent.find(({ type }) => type === "commit-detach").detachId);
      try { process.kill(-owned.supervisorPid, "SIGTERM"); } catch {}
      await waitForExit(owned.child);
      await waitForGone([tree.command, tree.descendant]);
    } finally {
      owned.child.send = originalSend;
      await forceCleanup(owned, [tree.command, tree.descendant]);
    }
  });

  it("treats a generic parent disconnect while prepared as cleanup, never as commit", async () => {
    const root = await temp();
    const marker = join(root, "detach-prepared-disconnect.json");
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", stubbornTreeScript(), marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    const entered = deferred();
    const release = deferred();
    try {
      const detaching = init.detachOwnedSupervisor(owned, {
        beforeCommit: async () => { entered.resolve(); await release.promise; },
      });
      await Promise.race([entered.promise, delay(1_000).then(() => { throw new Error("prepare barrier was not entered"); })]);
      owned.child.disconnect();
      release.resolve();
      await expect(detaching).resolves.toBe(false);
      await waitForExit(owned.child);
      await waitForGone([tree.command, tree.descendant]);
    } finally { await forceCleanup(owned, [tree.command, tree.descendant]); }
  });

  it("accepts a repeated nonce-bound commit request idempotently", async () => {
    const root = await temp();
    const marker = join(root, "detach-repeated-commit.json");
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", stubbornTreeScript(), marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    const originalSend = owned.child.send;
    let repeated = false;
    owned.child.send = function repeatCommit(message, ...args) {
      const result = originalSend.call(this, message, ...args);
      if (message?.type === "commit-detach" && !repeated) {
        repeated = true;
        originalSend.call(this, { ...message });
      }
      return result;
    };
    try {
      await expect(init.detachOwnedSupervisor(owned)).resolves.toBe(true);
      expect(repeated).toBe(true);
      expect(processAlive(tree.command)).toBe(true);
      try { process.kill(-owned.supervisorPid, "SIGTERM"); } catch {}
      await waitForExit(owned.child);
      await waitForGone([tree.command, tree.descendant]);
    } finally {
      owned.child.send = originalSend;
      await forceCleanup(owned, [tree.command, tree.descendant]);
    }
  });

  it("preserves a successful authenticated durable detach", async () => {
    const root = await temp();
    const marker = join(root, "detach-success.json");
    const owned = await init.spawnSupervisedProcess(process.execPath, ["-e", stubbornTreeScript(), marker], { cwd: root, stdio: "ignore" });
    const tree = await waitForJson(marker);
    const originalSend = owned.child.send;
    const sent = [];
    owned.child.send = function recordDetachMessages(message, ...args) {
      sent.push(message);
      return originalSend.call(this, message, ...args);
    };
    try {
      await expect(init.detachOwnedSupervisor(owned)).resolves.toBe(true);
      const detach = sent.find(({ type }) => type === "detach");
      const commit = sent.find(({ type }) => type === "commit-detach");
      expect(detach?.detachId).toMatch(/^[0-9a-f-]{36}$/);
      expect(commit).toMatchObject({ nonce: detach.nonce, detachId: detach.detachId });
      expect(processAlive(owned.supervisorPid)).toBe(true);
      expect(processAlive(tree.command)).toBe(true);
      expect(processAlive(tree.descendant)).toBe(true);
      try { process.kill(-owned.supervisorPid, "SIGTERM"); } catch {}
      await waitForExit(owned.child);
      await waitForGone([tree.command, tree.descendant]);
    } finally {
      owned.child.send = originalSend;
      await forceCleanup(owned, [tree.command, tree.descendant]);
    }
  });

  it("closes synchronous-spawn and pre-handshake cancellation races without publishing ownership", async () => {
    const syncSpawn = vi.fn(() => { throw Object.assign(new Error("injected sync spawn"), { code: "EACCES" }); });
    await expect(init.spawnSupervisedProcess("ignored", [], {}, { spawnImpl: syncSpawn })).rejects.toThrow(/injected sync spawn/);

    const controller = new AbortController();
    controller.abort(new Error("cancel before spawn"));
    const neverSpawn = vi.fn();
    await expect(init.spawnSupervisedProcess("ignored", [], {}, { spawnImpl: neverSpawn, signal: controller.signal })).rejects.toThrow(/cancel before spawn/);
    expect(neverSpawn).not.toHaveBeenCalled();

    const root = await temp();
    const marker = join(root, "must-not-start");
    const duringHandshake = new AbortController();
    let supervisor;
    const pending = init.spawnSupervisedProcess(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`], { cwd: root, stdio: "ignore" }, {
      signal: duringHandshake.signal,
      spawnImpl: (...args) => { supervisor = spawn(...args); return supervisor; },
    });
    duringHandshake.abort(new Error("cancel during handshake"));
    await expect(pending).rejects.toThrow(/cancel during handshake/);
    await waitForExit(supervisor);
    expect(processAlive(supervisor.pid)).toBe(false);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
