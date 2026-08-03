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
  afterOrderAllocated,
  afterClaimPublished,
  afterFencePrepared,
  afterFencePublished,
  afterDeadFencePinned,
  beforeDeadFenceRemoved,
  afterDeadFenceRemoved,
} = {}) {
  const absoluteLock = resolve(lockPath);
  const parent = dirname(absoluteLock);
  const lockName = basename(absoluteLock);
  const prefix = `${lockName}.`;
  const fencePath = `${absoluteLock}.owner`;
  if (confinementRoot) await assertSafeStoragePath(confinementRoot, absoluteLock);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (confinementRoot) {
    await assertSafeStoragePath(confinementRoot, parent);
    await assertSafeStoragePath(confinementRoot, absoluteLock);
    await assertSafeStoragePath(confinementRoot, `${absoluteLock}.recovery`);
    await assertSafeStoragePath(confinementRoot, fencePath);
  }

  const started = Date.now();
  const token = randomUUID();
  const metadata = { version: 3, pid: process.pid, token, created_at_ms: started };
  const tempPath = join(parent, `${prefix}${process.pid}.${token}.tmp`);
  let claimPath;
  let ownerCandidatePath;
  let fenceOwned = false;
  await writePreparedClaim(tempPath, metadata, confinementRoot);
  try {
    if (beforePublish) await beforePublish();
    const order = process.hrtime.bigint().toString().padStart(24, "0");
    claimPath = join(parent, `${prefix}${order}.${process.pid}.${token}.claim`);
    if (afterOrderAllocated) await afterOrderAllocated();
    if (confinementRoot) {
      await assertSafeStoragePath(confinementRoot, tempPath);
      await assertSafeStoragePath(confinementRoot, claimPath);
    }
    await rename(tempPath, claimPath);
    await syncDirectory(parent);
    if (afterClaimPublished) await afterClaimPublished();

    ownerCandidatePath = join(parent, `${prefix}${process.pid}.${token}.owner-candidate`);
    await atomicCreateFile(ownerCandidatePath, JSON.stringify(metadata), 0o600, confinementRoot);
    if (afterFencePrepared) await afterFencePrepared();

    let observedFirst = false;
    let fenceBlocker;
    while (true) {
      const legacy = await inspectLegacyOwner(absoluteLock, staleMs, confinementRoot);
      const claims = await inspectPublishedClaims(parent, prefix, staleMs, confinementRoot);
      await cleanupAbandonedTemps(parent, prefix, staleMs, confinementRoot);
      const fence = await inspectOwnerFence(fencePath, staleMs, confinementRoot);
      await cleanupDeadOwnerCandidates(parent, prefix, fence, staleMs, confinementRoot);
      const recoveryPins = await cleanupRecoveryPins(parent, prefix, staleMs, confinementRoot);
      const ownIndex = claims.findIndex((claim) => claim.path === claimPath && claim.token === token && claim.pid === process.pid);
      if (ownIndex < 0) throw new Error(`lock claim was lost before ownership: ${claimPath}`);
      const isFirst = !legacy.blocking && ownIndex === 0;
      if (isFirst && observedFirst) {
        const outcome = await acquireOrRecoverOwnerFence({
          fencePath,
          ownerCandidatePath,
          metadata,
          staleMs,
          confinementRoot,
          parent,
          prefix,
          recoveryPins,
          afterDeadFencePinned,
          beforeDeadFenceRemoved,
          afterDeadFenceRemoved,
        });
        fenceBlocker = outcome.blocker;
        if (outcome.acquired) {
          fenceOwned = true;
          if (afterFencePublished) await afterFencePublished();
          return releaseOwnLock({ fencePath, ownerCandidatePath, claimPath, metadata, confinementRoot });
        }
      }
      observedFirst = isFirst;
      if (Date.now() - started >= timeoutMs) {
        const blockers = [legacy.blocking, fenceBlocker, ...claims.slice(0, ownIndex).map((claim) => ({ claim: claim.name, pid: claim.pid, age_ms: claim.ageMs }))].filter(Boolean);
        if (ownerCandidatePath) await removeOwnedRecord(ownerCandidatePath, metadata, confinementRoot, "owner candidate");
        await removeOwnedClaim(claimPath, metadata, confinementRoot);
        throw new Error(`lock timeout: ${absoluteLock}; blockers=${JSON.stringify(blockers)}`);
      }
      await delay(pollMs);
    }
  } catch (error) {
    if (fenceOwned) {
      await releaseOwnedResources({ fencePath, ownerCandidatePath, claimPath, metadata, confinementRoot });
    } else {
      if (ownerCandidatePath) await removeOwnedRecord(ownerCandidatePath, metadata, confinementRoot, "owner candidate");
      if (claimPath) await removeOwnedClaim(claimPath, metadata, confinementRoot);
    }
    throw error;
  } finally {
    if (confinementRoot) await assertSafeStoragePath(confinementRoot, tempPath);
    await rm(tempPath, { force: true });
  }
}

async function acquireOrRecoverOwnerFence({
  fencePath,
  ownerCandidatePath,
  metadata,
  staleMs,
  confinementRoot,
  parent,
  prefix,
  recoveryPins,
  afterDeadFencePinned,
  beforeDeadFenceRemoved,
  afterDeadFenceRemoved,
}) {
  const fence = await inspectOwnerFence(fencePath, staleMs, confinementRoot);
  if (!fence.exists) {
    if (recoveryPins.length > 0) {
      return { acquired: false, blocker: { fence: basename(fencePath), recovery_pins: recoveryPins.map((pin) => basename(pin)) } };
    }
    if (confinementRoot) {
      await assertSafeStoragePath(confinementRoot, ownerCandidatePath);
      await assertSafeStoragePath(confinementRoot, fencePath);
    }
    try {
      // The claim queue chooses who may try; this no-replace hard link is the
      // actual ownership boundary that prevents a late lower claim entering.
      await link(ownerCandidatePath, fencePath);
      await syncDirectory(parent);
    } catch (error) {
      if (error?.code === "EEXIST" || error?.code === "ENOENT") return { acquired: false };
      throw error;
    }
    const [candidateRecord, fenceRecord, candidateIdentity, fenceIdentity, pinsAfterPublish] = await Promise.all([
      readJsonRecord(ownerCandidatePath, confinementRoot),
      readJsonRecord(fencePath, confinementRoot),
      readFileIdentity(ownerCandidatePath, confinementRoot),
      readFileIdentity(fencePath, confinementRoot),
      cleanupRecoveryPins(parent, prefix, staleMs, confinementRoot),
    ]);
    const ownsPublishedFence = candidateRecord.exists && !candidateRecord.invalid
      && candidateRecord.value?.pid === metadata.pid && candidateRecord.value?.token === metadata.token
      && fenceRecord.exists && !fenceRecord.invalid
      && fenceRecord.value?.pid === metadata.pid && fenceRecord.value?.token === metadata.token
      && candidateIdentity && fenceIdentity && sameIdentity(candidateIdentity, fenceIdentity);
    // A reclaimer may have pinned the previous fence after our earlier scan.
    // Do not enter until no old-inode reclaimer can still unlink this path.
    if (!ownsPublishedFence || pinsAfterPublish.length > 0) {
      if (ownsPublishedFence) {
        await removeImmutablePath(fencePath, confinementRoot);
        await syncDirectory(parent);
      }
      return { acquired: false };
    }
    return { acquired: true };
  }
  if (fence.invalid) return { acquired: false, blocker: { fence: basename(fencePath), invalid: true, age_ms: fence.ageMs } };
  if (Number.isSafeInteger(fence.pid) && fence.pid > 0 && isProcessAlive(fence.pid)) {
    return { acquired: false, blocker: { fence: basename(fencePath), pid: fence.pid, age_ms: fence.ageMs } };
  }
  if (fence.ageMs < staleMs) {
    return { acquired: false, blocker: { fence: basename(fencePath), pid: fence.pid, age_ms: fence.ageMs } };
  }
  await reclaimDeadOwnerFence({
    fencePath,
    parent,
    prefix,
    staleMs,
    confinementRoot,
    afterDeadFencePinned,
    beforeDeadFenceRemoved,
    afterDeadFenceRemoved,
  });
  return { acquired: false };
}

async function inspectOwnerFence(path, staleMs, confinementRoot) {
  const record = await readImmutableRecord(path, confinementRoot);
  if (!record) return { exists: false };
  const ageMs = Date.now() - (Number.isFinite(record.value?.created_at_ms) ? record.value.created_at_ms : record.info.mtimeMs);
  return {
    exists: true,
    invalid: record.invalid,
    pid: record.value?.pid,
    token: record.value?.token,
    ageMs,
    identity: await readFileIdentity(path, confinementRoot),
  };
}

async function reclaimDeadOwnerFence({
  fencePath,
  parent,
  prefix,
  staleMs,
  confinementRoot,
  afterDeadFencePinned,
  beforeDeadFenceRemoved,
  afterDeadFenceRemoved,
}) {
  const recoveryToken = randomUUID();
  const recoveryPin = join(parent, `${prefix}${process.pid}.${recoveryToken}.recovery-pin`);
  if (confinementRoot) {
    await assertSafeStoragePath(confinementRoot, fencePath);
    await assertSafeStoragePath(confinementRoot, recoveryPin);
  }
  try {
    // Keep the exact old inode alive and identifiable while revalidating. The
    // unique PID-scoped pin is also the publication barrier for a new owner.
    try { await link(fencePath, recoveryPin); } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (afterDeadFencePinned) await afterDeadFencePinned();
    const [pinned, current, pinnedIdentity, currentIdentity] = await Promise.all([
      readImmutableRecord(recoveryPin, confinementRoot),
      readImmutableRecord(fencePath, confinementRoot),
      readFileIdentity(recoveryPin, confinementRoot),
      readFileIdentity(fencePath, confinementRoot),
    ]);
    if (!pinned || !current || pinned.invalid || current.invalid || !pinnedIdentity || !currentIdentity) return;
    if (!sameIdentity(pinnedIdentity, currentIdentity)) return;
    if (pinned.value?.token !== current.value?.token || pinned.value?.pid !== current.value?.pid) return;
    const ageMs = Date.now() - (Number.isFinite(current.value?.created_at_ms) ? current.value.created_at_ms : current.info.mtimeMs);
    if (!Number.isSafeInteger(current.value?.pid) || current.value.pid <= 0 || isProcessAlive(current.value.pid) || ageMs < staleMs) return;
    if (beforeDeadFenceRemoved) await beforeDeadFenceRemoved();
    await rm(fencePath, { force: true });
    await syncDirectory(parent);
    if (afterDeadFenceRemoved) await afterDeadFenceRemoved();
  } finally {
    if (confinementRoot) await assertSafeStoragePath(confinementRoot, recoveryPin);
    await rm(recoveryPin, { force: true });
  }
}

async function cleanupDeadOwnerCandidates(parent, prefix, fence, staleMs, confinementRoot) {
  const names = (await readdir(parent)).filter((name) => name.startsWith(prefix) && name.endsWith(".owner-candidate"));
  for (const name of names) {
    const path = join(parent, name);
    const record = await readImmutableRecord(path, confinementRoot);
    if (!record || record.invalid) continue;
    const pid = record.value?.pid;
    const ageMs = Date.now() - (Number.isFinite(record.value?.created_at_ms) ? record.value.created_at_ms : record.info.mtimeMs);
    if (!Number.isSafeInteger(pid) || pid <= 0 || isProcessAlive(pid) || ageMs < staleMs) continue;
    const identity = await readFileIdentity(path, confinementRoot);
    if (identity && fence.identity && sameIdentity(identity, fence.identity)) continue;
    await removeImmutablePath(path, confinementRoot);
  }
}

async function cleanupRecoveryPins(parent, prefix, staleMs, confinementRoot) {
  const names = (await readdir(parent)).filter((name) => name.startsWith(prefix) && name.endsWith(".recovery-pin"));
  const remaining = [];
  for (const name of names) {
    const path = join(parent, name);
    const record = await readImmutableRecord(path, confinementRoot);
    if (!record) continue;
    const recovererPid = Number.parseInt(name.slice(prefix.length).split(".")[0] ?? "", 10);
    const ageMs = Date.now() - record.info.mtimeMs;
    if (Number.isSafeInteger(recovererPid) && recovererPid > 0 && !isProcessAlive(recovererPid) && ageMs >= staleMs) {
      await removeImmutablePath(path, confinementRoot);
      continue;
    }
    remaining.push(path);
  }
  return remaining;
}

async function readFileIdentity(path, confinementRoot) {
  try {
    if (confinementRoot) await assertSafeStoragePath(confinementRoot, path);
    const info = await lstat(path, { bigint: true });
    if (!info.isFile()) throw new Error(`lock owner artifact is not a regular file: ${path}`);
    return { dev: info.dev, ino: info.ino };
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
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

function releaseOwnLock(resources) {
  let released = false;
  return async () => {
    if (released) return;
    await releaseOwnedResources(resources);
    released = true;
  };
}

async function releaseOwnedResources({ fencePath, ownerCandidatePath, claimPath, metadata, confinementRoot }) {
  const fenceRecord = await readJsonRecord(fencePath, confinementRoot);
  const candidateRecord = await readJsonRecord(ownerCandidatePath, confinementRoot);
  if (!fenceRecord.exists || fenceRecord.invalid
    || fenceRecord.value?.pid !== metadata.pid || fenceRecord.value?.token !== metadata.token
    || !candidateRecord.exists || candidateRecord.invalid
    || candidateRecord.value?.pid !== metadata.pid || candidateRecord.value?.token !== metadata.token) {
    throw new Error(`lock owner fence ownership mismatch: ${fencePath}`);
  }
  const [fenceIdentity, candidateIdentity] = await Promise.all([
    readFileIdentity(fencePath, confinementRoot),
    readFileIdentity(ownerCandidatePath, confinementRoot),
  ]);
  if (!fenceIdentity || !candidateIdentity || !sameIdentity(fenceIdentity, candidateIdentity)) {
    throw new Error(`lock owner fence ownership mismatch: ${fencePath}`);
  }
  await removeImmutablePath(fencePath, confinementRoot);
  await syncDirectory(dirname(fencePath));
  await removeOwnedRecord(ownerCandidatePath, metadata, confinementRoot, "owner candidate");
  await removeOwnedClaim(claimPath, metadata, confinementRoot);
}

async function removeOwnedRecord(path, metadata, confinementRoot, label) {
  const record = await readJsonRecord(path, confinementRoot);
  if (!record.exists) return;
  if (record.invalid || record.value?.pid !== metadata.pid || record.value?.token !== metadata.token) {
    throw new Error(`lock ${label} ownership mismatch: ${path}`);
  }
  await removeImmutablePath(path, confinementRoot);
}

async function removeOwnedClaim(path, metadata, confinementRoot) {
  await removeOwnedRecord(path, metadata, confinementRoot, "claim");
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
