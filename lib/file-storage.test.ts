import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStorage, LocalStorageReadError } from "./file-storage";
import type { Run, Submission } from "./types";

const dirs: string[] = [];

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
    const appended = await Promise.all(Array.from({ length: 20 }, (_, n) => local.appendRunEvents("run-1", [{ ts: `2026-08-02T00:00:${String(n).padStart(2, "0")}.000Z`, type: "run.created", payload: { submission_id: String(n) } }])));
    expect(appended.flat().map((event) => event.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
    expect((await local.listRunEvents("run-1")).map((event) => event.seq)).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
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
});
