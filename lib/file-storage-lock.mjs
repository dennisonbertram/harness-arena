import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
    await writeSyncedFile(temp, value, mode, confinementRoot);
    if (confinementRoot) {
      await assertSafeStoragePath(confinementRoot, temp);
      await assertSafeStoragePath(confinementRoot, path);
    }
    await rename(temp, path);
    await syncDirectory(dirname(path));
  } finally {
    if (confinementRoot) await assertSafeStoragePath(confinementRoot, temp);
    await rm(temp, { force: true });
  }
}

export async function atomicCreateFile(path, value, mode = 0o600, confinementRoot, { beforePublish } = {}) {
  if (confinementRoot) await assertSafeStoragePath(confinementRoot, path);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (confinementRoot) {
    await assertSafeStoragePath(confinementRoot, parent);
    await assertSafeStoragePath(confinementRoot, path);
  }
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeSyncedFile(temp, value, mode, confinementRoot);
    if (beforePublish) await beforePublish();
    if (confinementRoot) {
      await assertSafeStoragePath(confinementRoot, temp);
      await assertSafeStoragePath(confinementRoot, path);
    }
    // link(2) is an atomic no-replace publication. Unlike rename(2), it
    // cannot overwrite a file another writer published while this temp was
    // being fsynced.
    await link(temp, path);
    await syncDirectory(parent);
  } finally {
    if (confinementRoot) await assertSafeStoragePath(confinementRoot, temp);
    await rm(temp, { force: true });
  }
}

async function writeSyncedFile(path, value, mode, confinementRoot) {
  if (confinementRoot) await assertSafeStoragePath(confinementRoot, path);
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function acquireDirectoryLock(lockPath, {
  staleMs = 5_000,
  timeoutMs = 15_000,
  pollMs = 10,
  confinementRoot,
  beforePublish,
} = {}) {
  const absoluteLock = resolve(lockPath);
  const parent = dirname(absoluteLock);
  const lockName = basename(absoluteLock);
  const prefix = `${lockName}.`;
  if (confinementRoot) await assertSafeStoragePath(confinementRoot, absoluteLock);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (confinementRoot) {
    await assertSafeStoragePath(confinementRoot, parent);
    await assertSafeStoragePath(confinementRoot, absoluteLock);
    await assertSafeStoragePath(confinementRoot, `${absoluteLock}.recovery`);
  }

  const started = Date.now();
  const token = randomUUID();
  const metadata = { version: 2, pid: process.pid, token, created_at_ms: started };
  const tempPath = join(parent, `${prefix}${process.pid}.${token}.tmp`);
  let claimPath;
  await writePreparedClaim(tempPath, metadata, confinementRoot);
  try {
    if (beforePublish) await beforePublish();
    const order = process.hrtime.bigint().toString().padStart(24, "0");
    claimPath = join(parent, `${prefix}${order}.${process.pid}.${token}.claim`);
    if (confinementRoot) {
      await assertSafeStoragePath(confinementRoot, tempPath);
      await assertSafeStoragePath(confinementRoot, claimPath);
    }
    await rename(tempPath, claimPath);

    let observedFirst = false;
    while (true) {
      const legacy = await inspectLegacyOwner(absoluteLock, staleMs, confinementRoot);
      const claims = await inspectPublishedClaims(parent, prefix, staleMs, confinementRoot);
      await cleanupAbandonedTemps(parent, prefix, staleMs, confinementRoot);
      const ownIndex = claims.findIndex((claim) => claim.path === claimPath && claim.token === token && claim.pid === process.pid);
      if (ownIndex < 0) throw new Error(`lock claim was lost before ownership: ${claimPath}`);
      const isFirst = !legacy.blocking && ownIndex === 0;
      if (isFirst && observedFirst) return releaseOwnClaim(claimPath, metadata, confinementRoot);
      observedFirst = isFirst;
      if (Date.now() - started >= timeoutMs) {
        const blockers = [legacy.blocking, ...claims.slice(0, ownIndex).map((claim) => ({ claim: claim.name, pid: claim.pid, age_ms: claim.ageMs }))].filter(Boolean);
        await removeOwnedClaim(claimPath, metadata, confinementRoot);
        throw new Error(`lock timeout: ${absoluteLock}; blockers=${JSON.stringify(blockers)}`);
      }
      await delay(pollMs);
    }
  } catch (error) {
    if (claimPath) await removeOwnedClaim(claimPath, metadata, confinementRoot);
    throw error;
  } finally {
    if (confinementRoot) await assertSafeStoragePath(confinementRoot, tempPath);
    await rm(tempPath, { force: true });
  }
}

async function writePreparedClaim(path, metadata, confinementRoot) {
  await writeSyncedFile(path, JSON.stringify(metadata), 0o600, confinementRoot);
}

async function inspectPublishedClaims(parent, prefix, staleMs, confinementRoot) {
  const names = (await readdir(parent)).filter((name) => name.startsWith(prefix) && name.endsWith(".claim")).sort();
  const claims = [];
  for (const name of names) {
    const path = join(parent, name);
    const claim = await readImmutableRecord(path, confinementRoot);
    if (!claim) continue;
    const ageMs = Date.now() - (Number.isFinite(claim.value?.created_at_ms) ? claim.value.created_at_ms : claim.info.mtimeMs);
    const pid = claim.value?.pid;
    if (Number.isSafeInteger(pid) && pid > 0 && !isProcessAlive(pid) && ageMs >= staleMs) {
      await removeImmutablePath(path, confinementRoot);
      continue;
    }
    claims.push({ path, name, pid, token: claim.value?.token, ageMs, invalid: claim.invalid });
  }
  return claims;
}

async function cleanupAbandonedTemps(parent, prefix, staleMs, confinementRoot) {
  const names = (await readdir(parent)).filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"));
  for (const name of names) {
    const path = join(parent, name);
    const record = await readImmutableRecord(path, confinementRoot);
    if (!record) continue;
    const encodedPid = Number.parseInt(name.slice(prefix.length).split(".")[0] ?? "", 10);
    const pid = Number.isSafeInteger(record.value?.pid) ? record.value.pid : encodedPid;
    const ageMs = Date.now() - (Number.isFinite(record.value?.created_at_ms) ? record.value.created_at_ms : record.info.mtimeMs);
    if (Number.isSafeInteger(pid) && pid > 0 && !isProcessAlive(pid) && ageMs >= staleMs) await removeImmutablePath(path, confinementRoot);
  }
}

async function inspectLegacyOwner(lockPath, staleMs, confinementRoot) {
  let info;
  try {
    if (confinementRoot) await assertSafeStoragePath(confinementRoot, lockPath);
    info = await lstat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { blocking: undefined };
    throw error;
  }
  if (!info.isDirectory()) throw new Error(`legacy lock path is not a directory: ${lockPath}`);
  const ownerPath = join(lockPath, "owner.json");
  const ownerRecord = await readJsonRecord(ownerPath, confinementRoot);
  const owner = ownerRecord.value;
  const ageMs = Date.now() - (Number.isFinite(owner?.created_at_ms) ? owner.created_at_ms : info.mtimeMs);
  if (ownerRecord.invalid) return { blocking: { legacy: lockPath, invalid: true, age_ms: ageMs } };
  if (Number.isSafeInteger(owner?.pid) && owner.pid > 0 && isProcessAlive(owner.pid)) {
    return { blocking: { legacy: lockPath, pid: owner.pid, age_ms: ageMs } };
  }
  if (ageMs < staleMs) return { blocking: { legacy: lockPath, pid: owner?.pid, age_ms: ageMs } };
  return { blocking: undefined };
}

async function readImmutableRecord(path, confinementRoot) {
  try {
    if (confinementRoot) await assertSafeStoragePath(confinementRoot, path);
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`lock claim is not a regular file: ${path}`);
    const record = await readJsonRecord(path, confinementRoot);
    if (!record.exists) return undefined;
    return { info, value: record.value, invalid: record.invalid };
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readJsonRecord(path, confinementRoot) {
  if (confinementRoot) await assertSafeStoragePath(confinementRoot, path);
  try { return { exists: true, value: JSON.parse(await readFile(path, "utf8")), invalid: false }; } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, value: undefined, invalid: false };
    if (error instanceof SyntaxError) return { exists: true, value: undefined, invalid: true };
    throw error;
  }
}

function releaseOwnClaim(path, metadata, confinementRoot) {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await removeOwnedClaim(path, metadata, confinementRoot);
  };
}

async function removeOwnedClaim(path, metadata, confinementRoot) {
  const record = await readJsonRecord(path, confinementRoot);
  if (!record.exists) return;
  if (record.invalid || record.value?.pid !== metadata.pid || record.value?.token !== metadata.token) throw new Error(`lock claim ownership mismatch: ${path}`);
  await removeImmutablePath(path, confinementRoot);
}

async function removeImmutablePath(path, confinementRoot) {
  if (confinementRoot) await assertSafeStoragePath(confinementRoot, path);
  await rm(path, { force: true });
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
