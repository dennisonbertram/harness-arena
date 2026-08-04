// Task image acquisition is intentionally driven by a repository lock, never
// a registry tag. A cached tag is only an optimization: its local Docker
// identity and registry manifest digest must both match the lock. Otherwise
// the runner pulls the immutable manifest digest and verifies it again before
// gateway/Pi startup or task execution.

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const TASK_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const LOOKUP_REF = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+$/;
const MAX_TASK_IMAGES = 64;

function exitCode(result) {
  return Number.isInteger(result?.code) && result.code >= 0 ? result.code : 1;
}

function stdout(result) {
  const value = result?.stdout;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : "";
}

function repositoryFor(lookupRef) {
  return lookupRef.slice(0, lookupRef.lastIndexOf(":"));
}

function lockedImageRef(entry) {
  return `${repositoryFor(entry.lookup_ref)}@${entry.manifest_digest}`;
}

function validLockEntry(entry) {
  return entry
    && typeof entry.task_id === "string"
    && TASK_ID.test(entry.task_id)
    && typeof entry.lookup_ref === "string"
    && LOOKUP_REF.test(entry.lookup_ref)
    && IMAGE_ID.test(entry.manifest_digest)
    && IMAGE_ID.test(entry.config_digest);
}

function lockByTask(tasks, lock) {
  if (!lock || lock.version !== 1 || !Array.isArray(lock.images) || lock.images.length !== tasks.length) return null;
  const entries = new Map();
  for (const entry of lock.images) {
    if (!validLockEntry(entry) || entries.has(entry.task_id)) return null;
    entries.set(entry.task_id, entry);
  }
  for (const task of tasks) {
    if (!task || typeof task.id !== "string" || !TASK_ID.test(task.id) || typeof task.image !== "string" || !task.image) return null;
    const entry = entries.get(task.id);
    if (!entry || entry.lookup_ref !== task.image) return null;
  }
  return entries;
}

function inspectedIdentity(result, entry) {
  if (exitCode(result) !== 0) return null;
  let image;
  try {
    image = JSON.parse(stdout(result));
  } catch {
    return null;
  }
  const expectedRepoDigest = lockedImageRef(entry);
  if (image?.Id !== entry.config_digest || !Array.isArray(image?.RepoDigests)) return null;
  return image.RepoDigests.includes(expectedRepoDigest) ? entry.config_digest : null;
}

function inspect(tools, reference, entry, timeoutMs) {
  try {
    return inspectedIdentity(tools.inspect(reference, timeoutMs), entry);
  } catch {
    return null;
  }
}

function deadlineBudget(deadlineMs, now) {
  if (!Number.isFinite(deadlineMs)) return undefined;
  return Math.max(0, Math.ceil(deadlineMs - now()));
}

function deadlineFailure(taskId) {
  return { ok: false, diagnostic: `task_image_readiness_timeout task_id=${taskId}` };
}

/**
 * Resolve every task selected by the authoritative manifest to an immutable,
 * verified config digest. The injected Docker operations keep the policy
 * deterministic in tests and ensure diagnostics never contain daemon output.
 */
export function resolveTaskImageIdentities(tasks, lock, tools, options = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > MAX_TASK_IMAGES) {
    return { ok: false, diagnostic: "task_image_manifest_invalid" };
  }
  const lockedTasks = lockByTask(tasks, lock);
  if (!lockedTasks) return { ok: false, diagnostic: "task_image_lock_invalid" };
  if (!tools || typeof tools.inspect !== "function" || typeof tools.pull !== "function") {
    return { ok: false, diagnostic: "task_image_lock_invalid" };
  }
  const now = typeof options.now === "function" ? options.now : Date.now;
  const deadlineMs = Number.isFinite(options.deadlineMs) ? options.deadlineMs : Number.POSITIVE_INFINITY;

  const readyTasks = [];
  const identities = [];
  const acquiredTaskIds = [];
  for (const task of tasks) {
    const entry = lockedTasks.get(task.id);
    let remainingMs = deadlineBudget(deadlineMs, now);
    if (remainingMs === 0) return deadlineFailure(task.id);
    let imageId = inspect(tools, entry.lookup_ref, entry, remainingMs);
    remainingMs = deadlineBudget(deadlineMs, now);
    if (remainingMs === 0) return deadlineFailure(task.id);
    if (!imageId) {
      const immutableRef = lockedImageRef(entry);
      let pullResult;
      try {
        pullResult = tools.pull(immutableRef, remainingMs);
      } catch {
        if (deadlineBudget(deadlineMs, now) === 0) return deadlineFailure(task.id);
        return { ok: false, diagnostic: `task_image_acquire_failed task_id=${task.id} exit_code=1` };
      }
      remainingMs = deadlineBudget(deadlineMs, now);
      if (remainingMs === 0) return deadlineFailure(task.id);
      const code = exitCode(pullResult);
      if (code !== 0) {
        return { ok: false, diagnostic: `task_image_acquire_failed task_id=${task.id} exit_code=${code}` };
      }
      imageId = inspect(tools, immutableRef, entry, remainingMs);
      if (deadlineBudget(deadlineMs, now) === 0) return deadlineFailure(task.id);
      if (!imageId) return { ok: false, diagnostic: `task_image_identity_mismatch task_id=${task.id}` };
      acquiredTaskIds.push(task.id);
    }
    readyTasks.push({ ...task, image: imageId });
    identities.push({ task_id: task.id, image_id: imageId, manifest_digest: entry.manifest_digest });
  }
  return { ok: true, tasks: readyTasks, identities, acquired_task_ids: acquiredTaskIds };
}
