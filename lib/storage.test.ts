import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get, list, put } from "@vercel/blob";
import { BlobStorage, getStorage, MemoryStorage } from "./storage";
import type { Run, Submission } from "./types";

vi.mock("@vercel/blob", () => ({
  get: vi.fn(),
  put: vi.fn(),
  list: vi.fn(),
}));

function makeRun(id: string, createdAt: string): Run {
  return {
    id,
    submission_id: "sub-1",
    status: "queued",
    task_results: [],
    created_at: createdAt,
  };
}

describe("MemoryStorage", () => {
  it("round-trips a Submission with every field intact", async () => {
    const storage = new MemoryStorage();
    const submission: Submission = {
      id: "sub-1",
      agent_name: "agent-x",
      prompt: "do the thing",
      status: "pending_review",
      judge_verdict: "approve",
      judge_reason: "looks good",
      judge_model: "gpt-5",
      judged_at: "2026-07-21T00:00:00.000Z",
      run_id: "run-1",
      created_at: "2026-07-20T00:00:00.000Z",
    };

    await storage.putSubmission(submission);
    const result = await storage.getSubmission("sub-1");

    expect(result).toEqual(submission);
  });

  it("round-trips a Run with every field intact, including nested task_results", async () => {
    const storage = new MemoryStorage();
    const run: Run = {
      id: "run-1",
      submission_id: "sub-1",
      status: "completed",
      started_at: "2026-07-21T00:00:00.000Z",
      finished_at: "2026-07-21T00:05:00.000Z",
      tasks_passed: 7,
      total_cost_usd: 1.23,
      over_budget: false,
      sandbox_id: "sandbox-1",
      task_results: [
        {
          task_id: "t1",
          attempted: true,
          passed: true,
          reward: 1,
          cost_usd: 0.1,
          duration_s: 12,
          turns: 3,
          trace_blob_url: "https://blob.example/t1.jsonl",
        },
      ],
      created_at: "2026-07-21T00:00:00.000Z",
    };

    await storage.putRun(run);
    const result = await storage.getRun("run-1");

    expect(result).toEqual(run);
  });

  it("listRuns returns runs ordered by created_at descending, regardless of insertion order", async () => {
    const storage = new MemoryStorage();
    const older = makeRun("run-old", "2026-07-01T00:00:00.000Z");
    const newer = makeRun("run-new", "2026-07-10T00:00:00.000Z");

    await storage.putRun(older);
    await storage.putRun(newer);

    const runs = await storage.listRuns();

    expect(runs.map((r) => r.id)).toEqual(["run-new", "run-old"]);
  });

  it("appendRunEvents assigns monotonic seq 1..n across two separate batches", async () => {
    const storage = new MemoryStorage();
    const runId = "run-1";

    const firstBatch = await storage.appendRunEvents(runId, [
      { ts: "2026-07-21T00:00:00.000Z", type: "run.created", payload: { submission_id: "sub-1" } },
      { ts: "2026-07-21T00:00:01.000Z", type: "run.sandbox_creating", payload: {} },
    ]);

    const secondBatch = await storage.appendRunEvents(runId, [
      { ts: "2026-07-21T00:00:02.000Z", type: "run.sandbox_ready", payload: { sandbox_id: "sb-1" } },
    ]);

    expect(firstBatch.map((e) => e.seq)).toEqual([1, 2]);
    expect(secondBatch.map((e) => e.seq)).toEqual([3]);
  });

  it("listRunEvents returns events in strict seq order", async () => {
    const storage = new MemoryStorage();
    const runId = "run-1";

    await storage.appendRunEvents(runId, [
      { ts: "2026-07-21T00:00:00.000Z", type: "run.created", payload: { submission_id: "sub-1" } },
    ]);
    await storage.appendRunEvents(runId, [
      {
        ts: "2026-07-21T00:00:01.000Z",
        type: "run.completed",
        payload: { tasks_passed: 1, total_cost_usd: 0.5, duration_s: 60 },
      },
    ]);

    const events = await storage.listRunEvents(runId);

    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.map((e) => e.type)).toEqual(["run.created", "run.completed"]);
  });

  it("listSubmissions returns an empty array when nothing has been stored", async () => {
    const storage = new MemoryStorage();
    expect(await storage.listSubmissions()).toEqual([]);
  });

  describe("regression: seq isolation and backend selection", () => {
    it("appendRunEvents keeps an independent seq counter per run_id", async () => {
      const storage = new MemoryStorage();

      const runAEvents = await storage.appendRunEvents("run-a", [
        { ts: "2026-07-21T00:00:00.000Z", type: "run.created", payload: { submission_id: "sub-1" } },
        { ts: "2026-07-21T00:00:01.000Z", type: "run.sandbox_creating", payload: {} },
      ]);
      const runBEvents = await storage.appendRunEvents("run-b", [
        { ts: "2026-07-21T00:00:02.000Z", type: "run.created", payload: { submission_id: "sub-2" } },
      ]);

      // If seq were a single global counter instead of per-run, run-b's
      // first event would come back as seq 3, not seq 1.
      expect(runAEvents.map((e) => e.seq)).toEqual([1, 2]);
      expect(runBEvents.map((e) => e.seq)).toEqual([1]);
    });

    describe("getStorage factory", () => {
      const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
      const originalStorage = process.env.STORAGE;

      afterEach(() => {
        if (originalToken === undefined) {
          delete process.env.BLOB_READ_WRITE_TOKEN;
        } else {
          process.env.BLOB_READ_WRITE_TOKEN = originalToken;
        }
        if (originalStorage === undefined) {
          delete process.env.STORAGE;
        } else {
          process.env.STORAGE = originalStorage;
        }
      });

      it("returns MemoryStorage when STORAGE=memory, even if BLOB_READ_WRITE_TOKEN is set", () => {
        process.env.STORAGE = "memory";
        process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_token";
        expect(getStorage()).toBeInstanceOf(MemoryStorage);
      });

      it("returns BlobStorage when BLOB_READ_WRITE_TOKEN is set and STORAGE is not memory", () => {
        delete process.env.STORAGE;
        process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_token";
        expect(getStorage()).toBeInstanceOf(BlobStorage);
      });

      it("throws when neither STORAGE=memory nor BLOB_READ_WRITE_TOKEN is set, rather than silently falling back to memory", () => {
        delete process.env.STORAGE;
        delete process.env.BLOB_READ_WRITE_TOKEN;
        expect(() => getStorage()).toThrow(
          "storage misconfigured: set BLOB_READ_WRITE_TOKEN or STORAGE=memory",
        );
      });
    });
  });
});

describe("BlobStorage (contract, @vercel/blob mocked)", () => {
  beforeEach(() => {
    vi.mocked(get).mockReset();
    vi.mocked(put).mockReset();
    vi.mocked(list).mockReset();
  });

  it("appendRunEvents continues seq across two batches, reading the prior batch back from the mocked blob store", async () => {
    const storage = new BlobStorage();
    const runId = "run-1";

    vi.mocked(get).mockResolvedValueOnce(null);
    vi.mocked(put).mockResolvedValueOnce({ url: "https://blob.example/events/run-1.jsonl" } as never);

    const firstBatch = await storage.appendRunEvents(runId, [
      { ts: "2026-07-21T00:00:00.000Z", type: "run.created", payload: { submission_id: "sub-1" } },
    ]);
    expect(firstBatch.map((e) => e.seq)).toEqual([1]);

    const writtenLines = firstBatch.map((e) => JSON.stringify(e)).join("\n");
    vi.mocked(get).mockResolvedValueOnce({
      statusCode: 200,
      stream: new Response(writtenLines).body,
      headers: new Headers(),
      blob: {} as never,
    } as never);
    vi.mocked(put).mockResolvedValueOnce({ url: "https://blob.example/events/run-1.jsonl" } as never);

    const secondBatch = await storage.appendRunEvents(runId, [
      { ts: "2026-07-21T00:00:01.000Z", type: "run.sandbox_ready", payload: { sandbox_id: "sb-1" } },
    ]);

    expect(secondBatch.map((e) => e.seq)).toEqual([2]);
  });

  it("listRunEvents parses the stored JSONL and returns events ordered by seq", async () => {
    const storage = new BlobStorage();
    const lines = [
      { run_id: "run-1", seq: 2, ts: "2026-07-21T00:00:01.000Z", type: "run.completed", payload: {} },
      { run_id: "run-1", seq: 1, ts: "2026-07-21T00:00:00.000Z", type: "run.created", payload: {} },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");

    vi.mocked(get).mockResolvedValueOnce({
      statusCode: 200,
      stream: new Response(lines).body,
      headers: new Headers(),
      blob: {} as never,
    } as never);

    const events = await storage.listRunEvents("run-1");

    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.map((e) => e.type)).toEqual(["run.created", "run.completed"]);
  });

  it("putSubmission writes JSON with access=public, no random suffix, allow overwrite, application/json content type", async () => {
    const storage = new BlobStorage();
    vi.mocked(put).mockResolvedValueOnce({ url: "https://blob.example/submissions/sub-1.json" } as never);

    await storage.putSubmission({
      id: "sub-1",
      agent_name: "agent-x",
      prompt: "do the thing",
      status: "queued",
      created_at: "2026-07-21T00:00:00.000Z",
    });

    expect(put).toHaveBeenCalledWith("submissions/sub-1.json", expect.any(String), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
  });

  it("listSubmissions follows list() pagination across multiple pages instead of only reading the first page", async () => {
    const storage = new BlobStorage();

    vi.mocked(list)
      .mockResolvedValueOnce({
        blobs: [{ url: "https://blob.example/submissions/sub-1.json" } as never],
        hasMore: true,
        cursor: "cursor-1",
      } as never)
      .mockResolvedValueOnce({
        blobs: [{ url: "https://blob.example/submissions/sub-2.json" } as never],
        hasMore: false,
      } as never);

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          text: async () => JSON.stringify({ id: "sub-1", created_at: "2026-07-01T00:00:00.000Z" }),
        })
        .mockResolvedValueOnce({
          text: async () => JSON.stringify({ id: "sub-2", created_at: "2026-07-02T00:00:00.000Z" }),
        }),
    );

    const result = await storage.listSubmissions();

    expect(result.map((s) => s.id).sort()).toEqual(["sub-1", "sub-2"]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "cursor-1" }));

    vi.unstubAllGlobals();
  });
});
