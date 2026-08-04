import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import imageLock from "../../config/task-image-lock.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { buildRunnerTasks } from "../../lib/tasks-for-runner.ts";
import { resolveTaskImageIdentities } from "./task-images.mjs";

function runnerPayload() {
  return Buffer.from(JSON.stringify(buildRunnerTasks()), "utf8").toString("base64");
}

function taskLock(task) {
  return imageLock.images.find((entry) => entry.task_id === task.id);
}

describe("resolveTaskImageIdentities", () => {
  it("derives an exact lock inventory from TASKS_JSON_B64 and executes only its locked config identities", () => {
    const fromManifest = JSON.parse(Buffer.from(runnerPayload(), "base64").toString("utf8"));
    const inspections = [];

    const result = resolveTaskImageIdentities(fromManifest, imageLock, {
      inspect(image) {
        inspections.push(image);
        const entry = imageLock.images.find((candidate) => candidate.lookup_ref === image);
        return {
          code: 0,
          stdout: JSON.stringify({
            Id: entry.config_digest,
            RepoDigests: [`${entry.lookup_ref.slice(0, entry.lookup_ref.lastIndexOf(":"))}@${entry.manifest_digest}`],
          }),
        };
      },
      pull() {
        throw new Error("unexpected pull");
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(inspections).toEqual(buildRunnerTasks().map((task) => task.image));
    expect(result.tasks.map((task) => task.image)).toEqual(imageLock.images.map((entry) => entry.config_digest));
    expect(result.acquired_task_ids).toEqual([]);
  });

  it("rejects a task-reference drift instead of silently accepting a changed or incomplete lock", () => {
    const tasks = JSON.parse(Buffer.from(runnerPayload(), "base64").toString("utf8"));
    tasks[0] = { ...tasks[0], image: "alexgshaw/changed:20251031" };
    const result = resolveTaskImageIdentities(tasks, imageLock, {
      inspect() {
        throw new Error("must not inspect an invalid manifest/lock pairing");
      },
      pull() {
        throw new Error("must not pull an invalid manifest/lock pairing");
      },
    });
    expect(result).toEqual({ ok: false, diagnostic: "task_image_lock_invalid" });
  });

  it("acquires only the immutable locked manifest when the cached tag has the wrong identity", () => {
    const fromManifest = JSON.parse(Buffer.from(runnerPayload(), "base64").toString("utf8"));
    const task = fromManifest[0];
    const entry = taskLock(task);
    const pulls = [];
    const inspections = [];
    const immutableRef = `${entry.lookup_ref.slice(0, entry.lookup_ref.lastIndexOf(":"))}@${entry.manifest_digest}`;

    const result = resolveTaskImageIdentities([task], { version: 1, images: [entry] }, {
      inspect(image) {
        inspections.push(image);
        if (image === task.image) {
          return { code: 0, stdout: JSON.stringify({ Id: `sha256:${"a".repeat(64)}`, RepoDigests: [] }) };
        }
        return {
          code: 0,
          stdout: JSON.stringify({ Id: entry.config_digest, RepoDigests: [immutableRef] }),
        };
      },
      pull(image) {
        pulls.push(image);
        return { code: 0, stdout: "registry token=must-not-leak" };
      },
    });

    expect(result).toMatchObject({ ok: true, acquired_task_ids: [task.id] });
    expect(pulls).toEqual([immutableRef]);
    expect(inspections).toEqual([task.image, immutableRef]);
    expect(result.tasks[0].image).toBe(entry.config_digest);
    expect(JSON.stringify(result)).not.toContain("token");
  });

  it("fails closed with bounded credential-free evidence when immutable acquisition cannot complete", () => {
    const task = JSON.parse(Buffer.from(runnerPayload(), "base64").toString("utf8"))[0];
    const entry = taskLock(task);
    const result = resolveTaskImageIdentities([task], { version: 1, images: [entry] }, {
      inspect() {
        return { code: 1, stdout: "registry credential=should-not-leak" };
      },
      pull() {
        return { code: 17, stdout: "registry credential=should-not-leak" };
      },
    });
    expect(result).toEqual({
      ok: false,
      diagnostic: `task_image_acquire_failed task_id=${task.id} exit_code=17`,
    });
    expect(JSON.stringify(result)).not.toContain("credential");
  });

  it("enforces one deadline across sequential image acquisitions", () => {
    const tasks = JSON.parse(Buffer.from(runnerPayload(), "base64").toString("utf8")).slice(0, 2);
    const entries = tasks.map(taskLock);
    const immutableRefs = new Map(entries.map((entry) => [
      `${entry.lookup_ref.slice(0, entry.lookup_ref.lastIndexOf(":"))}@${entry.manifest_digest}`,
      entry,
    ]));
    const pullTimeouts = [];
    let nowMs = 1_000;

    const result = resolveTaskImageIdentities(tasks, { version: 1, images: entries }, {
      inspect(image) {
        const entry = immutableRefs.get(image);
        return entry
          ? { code: 0, stdout: JSON.stringify({ Id: entry.config_digest, RepoDigests: [image] }) }
          : { code: 1, stdout: "cache miss" };
      },
      pull(_image, timeoutMs) {
        pullTimeouts.push(timeoutMs);
        nowMs += timeoutMs === 100 ? 60 : timeoutMs;
        return { code: timeoutMs === 40 ? 124 : 0 };
      },
    }, { deadlineMs: 1_100, now: () => nowMs });

    expect(result).toEqual({
      ok: false,
      diagnostic: `task_image_readiness_timeout task_id=${tasks[1].id}`,
    });
    expect(pullTimeouts).toEqual([100, 40]);
    expect(JSON.stringify(result)).not.toContain("cache miss");
  });

  it("wires image acquisition ahead of every gateway preflight and task loop", () => {
    const runnerSource = readFileSync(new URL("./runner.mjs", import.meta.url), "utf8");
    const readiness = runnerSource.indexOf("const imageReadiness = ensureTaskImagesReady(tasks, imageLock);");
    const gatewayPreflight = runnerSource.indexOf("const preflight = await preflightProxy(");
    const taskLoop = runnerSource.indexOf("for (let index = 0; index < readyTasks.length; index++)");

    expect(readiness).toBeGreaterThanOrEqual(0);
    expect(readiness).toBeLessThan(gatewayPreflight);
    expect(readiness).toBeLessThan(taskLoop);
    expect(runnerSource).toContain('runDocker(["pull", immutableRef]');
  });
});
