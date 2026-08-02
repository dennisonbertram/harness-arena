import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

export function safeStoragePart(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes("..")) {
    throw new Error(`unsafe local storage path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export async function atomicWriteFile(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, { mode });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function acquireDirectoryLock(lockPath, { staleMs = 5_000, timeoutMs = 15_000, pollMs = 10 } = {}) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const token = randomUUID();
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token, created_at_ms: Date.now() }), { mode: 0o600 });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const owner = await readOwner(lockPath);
        if (owner?.pid === process.pid && owner?.token === token) await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await inspectLock(lockPath);
      if (info.missing) continue;
      if (info.stale) {
        const quarantine = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
        try { await rename(lockPath, quarantine); await rm(quarantine, { recursive: true, force: true }); } catch (renameError) { if (renameError?.code !== "ENOENT") throw renameError; }
        continue;
      }
      if (Date.now() - started >= timeoutMs) throw new Error(`lock timeout: ${lockPath}`);
      await delay(pollMs);
    }
  }

  async function inspectLock(path) {
    try {
      const metadata = await stat(path);
      const owner = await readOwner(path);
      return { stale: Date.now() - metadata.mtimeMs >= staleMs && !isProcessAlive(owner?.pid) };
    } catch (error) {
      // A normal owner may have released between our failed mkdir and this
      // inspection. Retry mkdir; treating absence as stale creates an ABA
      // race that can rename a new owner's lock out from under it.
      if (error?.code === "ENOENT") return { stale: false, missing: true };
      throw error;
    }
  }
}

async function readOwner(lockPath) {
  try { return JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")); } catch { return undefined; }
}

export async function appendRunEventsFile(root, runId, values) {
  const id = safeStoragePart(runId);
  const absoluteRoot = resolve(root);
  const eventPath = join(absoluteRoot, "events", `${id}.json`);
  const lockPath = join(absoluteRoot, ".locks", "events", `${id}.lock`);
  const release = await acquireDirectoryLock(lockPath);
  try {
    let events = [];
    try { events = JSON.parse(await readFile(eventPath, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    let seq = events.reduce((max, event) => Math.max(max, event.seq), 0);
    const appended = values.map((event) => ({ ...event, run_id: id, seq: ++seq }));
    await atomicWriteFile(eventPath, JSON.stringify([...events, ...appended]));
    return appended;
  } finally {
    await release();
  }
}
