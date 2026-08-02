import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const LOCK_INITIALIZATION_GRACE_MS = 1_000;

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

export async function assertSafeStoragePath(root, path) {
  const absoluteRoot = resolve(root);
  const candidate = resolve(path);
  const rel = relative(absoluteRoot, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`local storage path escapes its root: ${candidate}`);
  const parts = rel ? rel.split(sep) : [];
  let current = absoluteRoot;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = join(current, parts[index]);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (error?.code === "ENOENT") return candidate;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`refusing local storage symlink component: ${current}`);
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error(`local storage path component is not a directory: ${current}`);
  }
  return candidate;
}

export async function assertNoSymlinksInTree(root) {
  const absoluteRoot = resolve(root);
  let info;
  try { info = await lstat(absoluteRoot); } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`refusing local storage symlink component: ${absoluteRoot}`);
  if (!info.isDirectory()) return;
  for (const entry of await readdir(absoluteRoot)) {
    const child = join(absoluteRoot, entry);
    const childInfo = await lstat(child);
    if (childInfo.isSymbolicLink()) throw new Error(`refusing local storage symlink component: ${child}`);
    if (childInfo.isDirectory()) await assertNoSymlinksInTree(child);
  }
}

export async function atomicWriteFile(path, value, mode = 0o600, confinementRoot) {
  if (confinementRoot) await assertSafeStoragePath(confinementRoot, path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (confinementRoot) await assertSafeStoragePath(confinementRoot, path);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, { mode });
    if (confinementRoot) {
      await assertSafeStoragePath(confinementRoot, temp);
      await assertSafeStoragePath(confinementRoot, path);
    }
    await rename(temp, path);
  } finally {
    if (confinementRoot) await assertSafeStoragePath(confinementRoot, temp);
    await rm(temp, { force: true });
  }
}

export async function acquireDirectoryLock(lockPath, { staleMs = 5_000, timeoutMs = 15_000, pollMs = 10, confinementRoot } = {}) {
  if (confinementRoot) await assertSafeStoragePath(confinementRoot, lockPath);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  if (confinementRoot) await assertSafeStoragePath(confinementRoot, lockPath);
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const token = randomUUID();
      if (confinementRoot) await assertSafeStoragePath(confinementRoot, join(lockPath, "owner.json"));
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token, created_at_ms: Date.now() }), { flag: "wx", mode: 0o600 });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        if (confinementRoot) await assertSafeStoragePath(confinementRoot, join(lockPath, "owner.json"));
        const owner = await readOwner(lockPath, confinementRoot);
        if (owner?.pid === process.pid && owner?.token === token) {
          if (confinementRoot) await assertSafeStoragePath(confinementRoot, lockPath);
          await rm(lockPath, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await inspectLock(lockPath);
      if (info.missing) continue;
      if (info.stale) {
        const releaseRecovery = await acquireRecoveryMutex(`${lockPath}.recovery`, { started, timeoutMs, pollMs, confinementRoot });
        try {
          const current = await inspectLock(lockPath);
          if (current.missing || !current.stale) continue;
          const quarantine = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
          if (confinementRoot) {
            await assertSafeStoragePath(confinementRoot, lockPath);
            await assertSafeStoragePath(confinementRoot, quarantine);
          }
          try {
            await rename(lockPath, quarantine);
            if (confinementRoot) await assertSafeStoragePath(confinementRoot, quarantine);
            await rm(quarantine, { recursive: true, force: true });
          } catch (renameError) {
            if (renameError?.code !== "ENOENT") throw renameError;
          }
        } finally {
          await releaseRecovery();
        }
        continue;
      }
      if (Date.now() - started >= timeoutMs) throw new Error(`lock timeout: ${lockPath}`);
      await delay(pollMs);
    }
  }

  async function inspectLock(path) {
    try {
      if (confinementRoot) await assertSafeStoragePath(confinementRoot, path);
      const metadata = await lstat(path);
      if (!metadata.isDirectory()) throw new Error(`lock path is not a directory: ${path}`);
      const owner = await readOwner(path, confinementRoot);
      const ageMs = Date.now() - metadata.mtimeMs;
      if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) {
        return { stale: ageMs >= Math.max(staleMs, LOCK_INITIALIZATION_GRACE_MS) };
      }
      return { stale: ageMs >= staleMs && !isProcessAlive(owner.pid) };
    } catch (error) {
      // A normal owner may have released between our failed mkdir and this
      // inspection. Retry mkdir; treating absence as stale creates an ABA
      // race that can rename a new owner's lock out from under it.
      if (error?.code === "ENOENT") return { stale: false, missing: true };
      throw error;
    }
  }
}

async function acquireRecoveryMutex(path, { started, timeoutMs, pollMs, confinementRoot }) {
  while (true) {
    try {
      if (confinementRoot) await assertSafeStoragePath(confinementRoot, path);
      await mkdir(path, { mode: 0o700 });
      const token = randomUUID();
      if (confinementRoot) await assertSafeStoragePath(confinementRoot, join(path, "owner.json"));
      await writeFile(join(path, "owner.json"), JSON.stringify({ pid: process.pid, token, created_at_ms: Date.now() }), { flag: "wx", mode: 0o600 });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        if (confinementRoot) await assertSafeStoragePath(confinementRoot, join(path, "owner.json"));
        const owner = await readOwner(path, confinementRoot);
        if (owner?.pid === process.pid && owner?.token === token) {
          if (confinementRoot) await assertSafeStoragePath(confinementRoot, path);
          await rm(path, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() - started >= timeoutMs) throw new Error(`recovery lock timeout: ${path}`);
      await delay(pollMs);
    }
  }
}

async function readOwner(lockPath, confinementRoot) {
  if (confinementRoot) await assertSafeStoragePath(confinementRoot, join(lockPath, "owner.json"));
  try { return JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")); } catch { return undefined; }
}

export async function appendRunEventsFile(root, runId, values) {
  const id = safeStoragePart(runId);
  const absoluteRoot = resolve(root);
  const eventPath = join(absoluteRoot, "events", `${id}.json`);
  const lockPath = join(absoluteRoot, ".locks", "events", `${id}.lock`);
  await assertSafeStoragePath(absoluteRoot, eventPath);
  await assertSafeStoragePath(absoluteRoot, lockPath);
  const release = await acquireDirectoryLock(lockPath, { confinementRoot: absoluteRoot });
  try {
    let events = [];
    await assertSafeStoragePath(absoluteRoot, eventPath);
    try { events = JSON.parse(await readFile(eventPath, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    let seq = events.reduce((max, event) => Math.max(max, event.seq), 0);
    const appended = values.map((event) => ({ ...event, run_id: id, seq: ++seq }));
    await atomicWriteFile(eventPath, JSON.stringify([...events, ...appended]), 0o600, absoluteRoot);
    return appended;
  } finally {
    await release();
  }
}
