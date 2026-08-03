import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileStorage, LocalStorageReadError } from "./file-storage";
import * as fileStorageModule from "./file-storage";
import { appendRunEventsFile } from "./file-storage-lock.mjs";
import type { Run, Submission } from "./types";

const dirs: string[] = [];
const concurrentAppendDeadlineMs = (writers: number, holdMs: number) => 1_000 + writers * (1_000 + holdMs);
const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function storage() {
  const dir = await mkdtemp(join(tmpdir(), "harness-arena-file-storage-"));
  dirs.push(dir);
  return new FileStorage(dir);
}

function submission(id: string): Submission {
  return { id, agent_name: "local-agent", prompt: "test", status: "pending_review", created_at: "2026-08-02T00:00:00.000Z" };
}

function run(id: string): Run {
  return { id, submission_id: "sub-1", status: "queued", task_results: [], created_at: "2026-08-02T00:00:00.000Z" };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileStorage", () => {
  it("implements durable entity, trace, and event storage", async () => {
    const local = await storage();
    await local.putSubmission(submission("sub-1"));
    await local.putRun(run("run-1"));
    await local.putTraceBlob("run-1", "task-1", "stdout.log", "hello");
    await local.appendRunEvents("run-1", [{ ts: "2026-08-02T00:00:00.000Z", type: "run.created", payload: { submission_id: "sub-1" } }]);

    const reopened = new FileStorage(local.root);
    await expect(reopened.getSubmission("sub-1")).resolves.toEqual(submission("sub-1"));
    await expect(reopened.listRuns()).resolves.toEqual([run("run-1")]);
    await expect(reopened.getTraceBytes("run-1", "task-1", "stdout.log")).resolves.toEqual(Buffer.from("hello"));
    await expect(reopened.listRunEvents("run-1")).resolves.toMatchObject([{ seq: 1, run_id: "run-1", type: "run.created" }]);
  });

  it("assigns strictly monotonic event sequences under concurrent appends", async () => {
    const local = await storage();
    const writers = 20;
    const holdMs = 25;
    const deadlineMs = concurrentAppendDeadlineMs(writers, holdMs);
    let acquisitions = 0;
    const appended = await Promise.all(Array.from({ length: writers }, (_, n) => appendRunEventsFile(local.root, "run-1", [{ ts: `2026-08-02T00:00:${String(n).padStart(2, "0")}.000Z`, type: "run.created", payload: { submission_id: String(n) } }], {
      lock: {
        timeoutMs: deadlineMs,
        afterFencePublished: async () => {
          acquisitions += 1;
          await delay(holdMs);
        },
      },
    })));
    expect(acquisitions).toBe(writers);
    expect(appended.flat().map((event) => event.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
    expect((await local.listRunEvents("run-1")).map((event) => event.seq)).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
  }, concurrentAppendDeadlineMs(20, 25));

  it("persists a small latest-event index with each event append", async () => {
    const local = await storage();
    await local.appendRunEvents("run-1", [
      { ts: "2026-08-02T00:00:00.000Z", type: "run.created", payload: {} },
      { ts: "2026-08-02T00:01:00.000Z", type: "task.started", payload: {} },
    ]);

    const eventPath = join(local.root, "events", "run-1.json");
    const indexPath = join(local.root, "events", "run-1.index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const eventInfo = await stat(eventPath);
    const indexInfo = await stat(indexPath);
    expect(index).toMatchObject({ version: 1, latest_ts: "2026-08-02T00:01:00.000Z" });
    expect(index.event_identity).toMatchObject({ size: eventInfo.size, mtime_ms: eventInfo.mtimeMs });
    expect(indexInfo.mode & 0o777).toBe(0o600);
    expect((await readdir(join(local.root, "events"))).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("rebuilds a stale index from a legacy event array and removes an orphan index", async () => {
    const local = await storage();
    await local.appendRunEvents("run-1", [{ ts: "2026-08-02T00:00:00.000Z", type: "run.created", payload: {} }]);
    const eventPath = join(local.root, "events", "run-1.json");
    const indexPath = join(local.root, "events", "run-1.index.json");
    // Existing worktrees use the original array-only representation. Changing
    // it invalidates the sidecar identity and forces a one-time safe rebuild.
    await writeFile(eventPath, JSON.stringify([
      { run_id: "run-1", seq: 1, ts: "2026-08-02T00:00:00.000Z", type: "run.created", payload: {} },
      { run_id: "run-1", seq: 2, ts: "2026-08-02T00:02:00.000Z", type: "task.started", payload: {} },
    ]));
    await expect(local.latestEventTimestamp("run-1")).resolves.toBe("2026-08-02T00:02:00.000Z");
    expect(JSON.parse(await readFile(indexPath, "utf8"))).toMatchObject({ latest_ts: "2026-08-02T00:02:00.000Z" });

    await rm(eventPath);
    await expect(local.latestEventTimestamp("run-1")).resolves.toBeUndefined();
    await expect(readFile(indexPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails loudly instead of accepting a corrupt local document", async () => {
    const local = await storage();
    await local.putSubmission(submission("sub-1"));
    await writeFile(join(local.root, "submissions", "sub-1.json"), "{not json}");
    await expect(local.getSubmission("sub-1")).rejects.toBeInstanceOf(LocalStorageReadError);
  });

  it("keeps independent worktrees completely isolated", async () => {
    const first = await storage();
    const second = await storage();
    await first.putSubmission(submission("sub-1"));
    await expect(second.getSubmission("sub-1")).resolves.toBeUndefined();
  });

  it("preserves all events with unique monotonic sequence across 20 processes", async () => {
    const local = await storage();
    const workers = 20;
    const holdMs = 25;
    const deadlineMs = concurrentAppendDeadlineMs(workers, holdMs);
    const workerOutput: string[] = [];
    await Promise.all(Array.from({ length: workers }, (_, index) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/tests/file-storage-worker.mjs", local.root, "run-1", String(index)], {
        cwd: process.cwd(),
        env: { ...process.env, HARNESS_FILE_STORAGE_LOCK_HOLD_MS: String(holdMs), HARNESS_FILE_STORAGE_LOCK_TIMEOUT_MS: String(deadlineMs) },
        stdio: "pipe",
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.once("error", (error) => reject(new Error(`worker ${index} failed to start: ${error.message}; output=${output}`)));
      child.once("close", (code, signal) => {
        workerOutput[index] = output;
        code === 0 ? resolve() : reject(new Error(`worker ${index} failed (code=${code}, signal=${signal}): ${output}`));
      });
    })));
    const events = await local.listRunEvents("run-1");
    expect(workerOutput.filter((output) => output.includes("lock-acquired")).length).toBe(workers);
    expect(events).toHaveLength(workers);
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: workers }, (_, index) => index + 1));
    expect(new Set(events.map((event) => event.payload.submission_id)).size).toBe(workers);
  }, concurrentAppendDeadlineMs(20, 25));

  it.each([".", "..", "../escape", "a/b", "a\\b", "%2e%2e%2fescape", "a..b"])("rejects unsafe path segment %j", (part) => {
    expect(() => fileStorageModule.safeStoragePart(part)).toThrow(/path segment/);
  });

  it("fails closed in production and Vercel environments", () => {
    try {
      vi.stubEnv("NODE_ENV", "production");
      expect(() => new FileStorage("/tmp/local-storage-must-not-open")).toThrow(/production/);
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("VERCEL", "1");
      expect(() => new FileStorage("/tmp/local-storage-must-not-open")).toThrow(/Vercel/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a symlink component before trace reads or writes and never modifies the external target", async () => {
    const local = await storage();
    const outside = await mkdtemp(join(tmpdir(), "harness-arena-file-storage-outside-"));
    dirs.push(outside);
    await mkdir(join(outside, "run-1", "task-1"), { recursive: true });
    const external = join(outside, "run-1", "task-1", "stdout.log");
    await writeFile(external, "keep");
    await symlink(outside, join(local.root, "traces"));

    const readOutcome = await local.getTraceBytes("run-1", "task-1", "stdout.log").then(() => "resolved", () => "rejected");
    const writeOutcome = await local.putTraceBlob("run-1", "task-1", "stdout.log", "clobber").then(() => "resolved", () => "rejected");
    const externalValue = await readFile(external, "utf8").catch(() => "missing");
    expect({ readOutcome, writeOutcome, externalValue }).toEqual({ readOutcome: "rejected", writeOutcome: "rejected", externalValue: "keep" });
  });

  it("rejects a symlinked readiness directory before its write/delete probe touches the external target", async () => {
    const local = await storage();
    await local.putCompetition({
      id: "local-development", arena: "harness-arena", harness: "pi", model: "local", prize_amount_usd: null,
      prize_cadence: null, status: "live", auto_baseline: false, created_at: "2026-08-02T00:00:00.000Z",
    });
    const outside = await mkdtemp(join(tmpdir(), "harness-arena-ready-outside-"));
    dirs.push(outside);
    const uuid = "00000000-0000-4000-8000-000000000000";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(uuid);
    const external = join(outside, `probe-${process.pid}-${uuid}.txt`);
    await writeFile(external, "keep");
    await symlink(outside, join(local.root, "ready"));

    const readinessOutcome = await local.checkReady().then(() => "resolved", () => "rejected");
    const externalValue = await readFile(external, "utf8").catch(() => "missing");
    expect({ readinessOutcome, externalValue }).toEqual({ readinessOutcome: "rejected", externalValue: "keep" });
  });

  it("does not accept a partial object as the local-development readiness seed", async () => {
    const local = await storage();
    await mkdir(join(local.root, "competitions"), { recursive: true });
    await writeFile(join(local.root, "competitions", "local-development.json"), JSON.stringify({ auto_baseline: false }));
    await expect(local.checkReady()).rejects.toThrow(/seed|competition|invalid|schema/i);
  });
});
