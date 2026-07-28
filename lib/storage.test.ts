import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get, list, put } from "@vercel/blob";
import { BlobStorage, getStorage, MemoryStorage, PartialReadError, seqFromEventPathname } from "./storage";
import type { Competition, Run, Submission } from "./types";

function makeCompetition(id: string, overrides: Partial<Competition> = {}): Competition {
  return {
    id,
    arena: "harness-arena",
    harness: "pi",
    model: "zai/glm-5.2",
    prize_amount_usd: null,
    prize_cadence: null,
    status: "live",
    created_at: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

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

  it("round-trips a Competition with prize fields left null (issue #75)", async () => {
    const storage = new MemoryStorage();
    const competition = makeCompetition("comp-1");

    await storage.putCompetition(competition);
    const result = await storage.getCompetition("comp-1");

    expect(result).toEqual(competition);
  });

  it("stores trace strings and buffers as bytes and returns null for absent traces", async () => {
    const storage = new MemoryStorage();
    await storage.putTraceBlob("run-1", "task-1", "stdout.log", "hello");
    await storage.putTraceBlob("run-1", "task-1", "stderr.log", Buffer.from("problem"));

    await expect(storage.getTraceBytes("run-1", "task-1", "stdout.log")).resolves.toEqual(Buffer.from("hello"));
    await expect(storage.getTraceBytes("run-1", "task-1", "stderr.log")).resolves.toEqual(Buffer.from("problem"));
    await expect(storage.getTraceBytes("run-1", "task-1", "missing.log")).resolves.toBeNull();
  });

  it("getCompetition returns undefined for an id that was never stored", async () => {
    const storage = new MemoryStorage();
    expect(await storage.getCompetition("nope")).toBeUndefined();
  });

  it("listCompetitions returns competitions ordered by created_at descending", async () => {
    const storage = new MemoryStorage();
    const older = makeCompetition("comp-old", { created_at: "2026-07-01T00:00:00.000Z" });
    const newer = makeCompetition("comp-new", { created_at: "2026-07-10T00:00:00.000Z" });

    await storage.putCompetition(older);
    await storage.putCompetition(newer);

    const result = await storage.listCompetitions();
    expect(result.map((c) => c.id)).toEqual(["comp-new", "comp-old"]);
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

      // A fresh MemoryStorage per call makes STORAGE=memory useless for
      // anything multi-request: a POST writes into one instance and the next
      // GET reads an empty one. Local dev and API smoke tests both need it to
      // persist for the life of the process.
      // Next.js gives server components and route handlers separate module
      // graphs, so a module-level singleton is per-graph: a competition created
      // through a route handler is invisible to the page rendering it. Pinning
      // the instance on globalThis under a cross-realm Symbol.for key is what
      // makes STORAGE=memory usable for a real request flow.
      it("pins the MemoryStorage instance on globalThis so it spans module graphs", () => {
        process.env.STORAGE = "memory";
        const key = Symbol.for("harness-arena.memory-storage");
        delete (globalThis as Record<symbol, unknown>)[key];

        const instance = getStorage();

        expect((globalThis as Record<symbol, unknown>)[key]).toBe(instance);
      });

      it("returns the SAME MemoryStorage instance across calls", () => {
        process.env.STORAGE = "memory";
        expect(getStorage()).toBe(getStorage());
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

  it("appendRunEvents writes ONE immutable blob per event, not a single rewritten events file", async () => {
    // This is the production data-loss bug: read-modify-rewrite of a single
    // events/<runId>.jsonl blob loses earlier writes under Vercel Blob's
    // eventual-consistency reads. Each event must land in its own blob.
    const storage = new BlobStorage();
    const runId = "run-1";

    vi.mocked(list).mockResolvedValueOnce({ blobs: [], hasMore: false } as never);
    vi.mocked(put).mockResolvedValue({ url: "https://blob.example/events/run-1/x.json" } as never);

    const appended = await storage.appendRunEvents(runId, [
      { ts: "2026-07-21T00:00:00.000Z", type: "run.created", payload: { submission_id: "sub-1" } },
      { ts: "2026-07-21T00:00:01.000Z", type: "run.sandbox_creating", payload: {} },
      { ts: "2026-07-21T00:00:02.000Z", type: "run.sandbox_ready", payload: { sandbox_id: "sb-1" } },
    ]);

    expect(appended.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(put).toHaveBeenCalledTimes(3);
    const pathnames = vi.mocked(put).mock.calls.map((call) => call[0]);
    expect(pathnames).toEqual([
      "events/run-1/0000000001.json",
      "events/run-1/0000000002.json",
      "events/run-1/0000000003.json",
    ]);
    expect(new Set(pathnames).size).toBe(3);
    expect(pathnames.some((p) => p.endsWith(`${runId}.jsonl`))).toBe(false);
  });

  it("appendRunEvents continues seq monotonically across two batches (second call lists the first batch's blobs)", async () => {
    const storage = new BlobStorage();
    const runId = "run-1";

    vi.mocked(list).mockResolvedValueOnce({ blobs: [], hasMore: false } as never);
    vi.mocked(put).mockResolvedValueOnce({ url: "https://blob.example/events/run-1/0000000001.json" } as never);

    const firstBatch = await storage.appendRunEvents(runId, [
      { ts: "2026-07-21T00:00:00.000Z", type: "run.created", payload: { submission_id: "sub-1" } },
    ]);
    expect(firstBatch.map((e) => e.seq)).toEqual([1]);

    vi.mocked(list).mockResolvedValueOnce({
      blobs: [{ url: "https://blob.example/events/run-1/0000000001.json", pathname: "events/run-1/0000000001.json" }],
      hasMore: false,
    } as never);
    vi.mocked(put).mockResolvedValueOnce({ url: "https://blob.example/events/run-1/0000000002.json" } as never);

    const secondBatch = await storage.appendRunEvents(runId, [
      { ts: "2026-07-21T00:00:01.000Z", type: "run.sandbox_ready", payload: { sandbox_id: "sb-1" } },
    ]);

    expect(secondBatch.map((e) => e.seq)).toEqual([2]);
    expect(put).toHaveBeenLastCalledWith(
      "events/run-1/0000000002.json",
      expect.any(String),
      expect.objectContaining({ allowOverwrite: false }),
    );
  });

  it("advances the sequence after a write collision instead of dropping the event batch", async () => {
    const storage = new BlobStorage();
    vi.mocked(list).mockResolvedValueOnce({ blobs: [], hasMore: false } as never);
    vi.mocked(put)
      .mockRejectedValueOnce(new Error("already exists"))
      .mockResolvedValueOnce({ url: "https://blob.example/events/run-1/0000000002.json" } as never);

    const appended = await storage.appendRunEvents("run-1", [
      { ts: "2026-07-21T00:00:00.000Z", type: "run.created", payload: { submission_id: "sub-1" } },
    ]);

    expect(appended.map((event) => event.seq)).toEqual([2]);
    expect(put).toHaveBeenNthCalledWith(2, "events/run-1/0000000002.json", expect.any(String), expect.any(Object));
  });

  it("listRunEvents lists per-seq blobs, fetches each, and returns events ordered by seq", async () => {
    const storage = new BlobStorage();

    vi.mocked(list).mockResolvedValueOnce({
      blobs: [
        { url: "https://blob.example/events/run-1/0000000002.json", pathname: "events/run-1/0000000002.json" },
        { url: "https://blob.example/events/run-1/0000000001.json", pathname: "events/run-1/0000000001.json" },
      ],
      hasMore: false,
    } as never);

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          text: async () =>
            JSON.stringify({ run_id: "run-1", seq: 2, ts: "2026-07-21T00:00:01.000Z", type: "run.completed", payload: {} }),
        })
        .mockResolvedValueOnce({
          text: async () =>
            JSON.stringify({ run_id: "run-1", seq: 1, ts: "2026-07-21T00:00:00.000Z", type: "run.created", payload: {} }),
        }),
    );

    const events = await storage.listRunEvents("run-1");

    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.map((e) => e.type)).toEqual(["run.created", "run.completed"]);

    vi.unstubAllGlobals();
  });

  it("listRunEvents skips an event blob that 403s (HTML error page) instead of throwing", async () => {
    const storage = new BlobStorage();
    vi.mocked(list).mockResolvedValue({
      blobs: [
        { url: "https://blob.example/events/run-1/0000000001.json", pathname: "events/run-1/0000000001.json" },
        { url: "https://blob.example/events/run-1/0000000002.json", pathname: "events/run-1/0000000002.json" },
      ],
      hasMore: false,
    } as never);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        // seq 1 fetches fine
        .mockResolvedValueOnce({
          ok: true,
          text: async () =>
            JSON.stringify({ run_id: "run-1", seq: 1, ts: "2026-07-21T00:00:00.000Z", type: "run.created", payload: {} }),
        })
        // seq 2 is a rate-limited HTML 403 page on every retry
        .mockResolvedValue({ ok: false, status: 403, text: async () => "<!DOCTYPE html><html>Forbidden</html>" }),
    );

    const events = await storage.listRunEvents("run-1");

    // The unreadable event is skipped; the route gets partial data, not a 500.
    expect(events.map((e) => e.seq)).toEqual([1]);
    vi.unstubAllGlobals();
  });

  it("latestEventTimestamp uses list() metadata only — no per-event content fetch", async () => {
    const storage = new BlobStorage();
    vi.mocked(list).mockResolvedValue({
      blobs: [
        { url: "u1", pathname: "events/run-1/0000000001.json", uploadedAt: "2026-07-21T00:00:00.000Z" },
        { url: "u2", pathname: "events/run-1/0000000002.json", uploadedAt: "2026-07-21T00:05:00.000Z" },
      ],
      hasMore: false,
    } as never);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const ts = await storage.latestEventTimestamp("run-1");

    expect(ts).toBe("2026-07-21T00:05:00.000Z");
    expect(fetchSpy).not.toHaveBeenCalled(); // reaper must not fetch event contents
    vi.unstubAllGlobals();
  });

  it("returns no latest timestamp when an event listing is empty", async () => {
    const storage = new BlobStorage();
    vi.mocked(list).mockResolvedValueOnce({ blobs: [], hasMore: false } as never);

    await expect(storage.latestEventTimestamp("run-1")).resolves.toBeUndefined();
  });

  describe("regression: event log never falls back to a single rewritten blob", () => {
    it("appendRunEvents never calls get() — it must not read back a shared blob to merge into", async () => {
      // The original bug was a read-modify-rewrite of one shared blob. If
      // that pattern is ever reintroduced (even under a different pathname),
      // it would show up as a call to get() from appendRunEvents. Per-blob
      // writes never need to read anything back.
      const storage = new BlobStorage();
      vi.mocked(list).mockResolvedValueOnce({ blobs: [], hasMore: false } as never);
      vi.mocked(put).mockResolvedValue({ url: "https://blob.example/events/run-1/0000000001.json" } as never);

      await storage.appendRunEvents("run-1", [
        { ts: "2026-07-21T00:00:00.000Z", type: "run.created", payload: { submission_id: "sub-1" } },
      ]);

      expect(get).not.toHaveBeenCalled();
    });

    it("zero-pads seq to 10 digits so lexical blob-name order matches numeric seq order past single digits", async () => {
      // Guards against dropping/shrinking the zero-pad width: without it,
      // "events/run-1/10.json" would sort lexically before
      // "events/run-1/9.json", silently reordering the timeline.
      const storage = new BlobStorage();
      vi.mocked(list).mockResolvedValueOnce({
        blobs: Array.from({ length: 9 }, (_, i) => ({
          url: `https://blob.example/events/run-1/000000000${i + 1}.json`,
        })),
        hasMore: false,
      } as never);
      vi.mocked(put).mockResolvedValue({ url: "https://blob.example/events/run-1/0000000010.json" } as never);

      const [tenth] = await storage.appendRunEvents("run-1", [
        { ts: "2026-07-21T00:00:09.000Z", type: "run.sandbox_ready", payload: {} },
      ]);

      expect(tenth.seq).toBe(10);
      const pathname = vi.mocked(put).mock.calls[0][0];
      expect(pathname).toBe("events/run-1/0000000010.json");
      expect(["events/run-1/0000000009.json", pathname].sort()).toEqual([
        "events/run-1/0000000009.json",
        pathname,
      ]);
    });
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

  it("putCompetition writes JSON with the same access/overwrite/content-type conventions as putSubmission", async () => {
    const storage = new BlobStorage();
    vi.mocked(put).mockResolvedValueOnce({ url: "https://blob.example/competitions/comp-1.json" } as never);

    await storage.putCompetition(makeCompetition("comp-1"));

    expect(put).toHaveBeenCalledWith("competitions/comp-1.json", expect.any(String), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
  });

  it("reads entity JSON through get(), including a missing blob", async () => {
    const storage = new BlobStorage();
    const run = makeRun("run-1", "2026-07-21T00:00:00.000Z");
    vi.mocked(get)
      .mockResolvedValueOnce({ stream: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(run))); controller.close(); } }) } as never)
      .mockResolvedValueOnce(null as never);

    expect(await storage.getRun("run-1")).toEqual(run);
    expect(await storage.getSubmission("missing")).toBeUndefined();
    expect(get).toHaveBeenNthCalledWith(1, "runs/run-1.json", { access: "public" });
  });

  it("stores trace data and returns raw trace bytes, or null when the trace is absent", async () => {
    const storage = new BlobStorage();
    vi.mocked(put).mockResolvedValueOnce({ url: "https://blob.example/traces/run-1/task-1/output.log" } as never);
    vi.mocked(get)
      .mockResolvedValueOnce({ stream: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("trace output")); controller.close(); } }) } as never)
      .mockResolvedValueOnce(null as never);

    await expect(storage.putTraceBlob("run-1", "task-1", "output.log", "trace output")).resolves.toBe(
      "https://blob.example/traces/run-1/task-1/output.log",
    );
    await expect(storage.getTraceBytes("run-1", "task-1", "output.log")).resolves.toEqual(Buffer.from("trace output"));
    await expect(storage.getTraceBytes("run-1", "task-1", "missing.log")).resolves.toBeNull();
    expect(put).toHaveBeenCalledWith("traces/run-1/task-1/output.log", "trace output", {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  });

  it("returns null when trace reads keep failing after retries", async () => {
    const storage = new BlobStorage();
    vi.mocked(get).mockRejectedValue(new Error("temporary blob failure"));

    await expect(storage.getTraceBytes("run-1", "task-1", "output.log")).resolves.toBeNull();
  });

  it("listCompetitions follows list() pagination across multiple pages", async () => {
    const storage = new BlobStorage();

    vi.mocked(list)
      .mockResolvedValueOnce({
        blobs: [{ url: "https://blob.example/competitions/comp-1.json" } as never],
        hasMore: true,
        cursor: "cursor-1",
      } as never)
      .mockResolvedValueOnce({
        blobs: [{ url: "https://blob.example/competitions/comp-2.json" } as never],
        hasMore: false,
      } as never);

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          text: async () => JSON.stringify(makeCompetition("comp-1")),
        })
        .mockResolvedValueOnce({
          text: async () => JSON.stringify(makeCompetition("comp-2", { created_at: "2026-07-28T00:00:00.000Z" })),
        }),
    );

    const result = await storage.listCompetitions();

    expect(result.map((c) => c.id).sort()).toEqual(["comp-1", "comp-2"]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "cursor-1" }));

    vi.unstubAllGlobals();
  });

  describe("regression: pagination and misconfiguration are not partially fixed", () => {
    it("listRuns also follows list() pagination across multiple pages, not just listSubmissions", async () => {
      // Guards against a fix applied to listSubmissions only, leaving
      // listRuns silently truncated at the first page.
      const storage = new BlobStorage();

      vi.mocked(list)
        .mockResolvedValueOnce({
          blobs: [{ url: "https://blob.example/runs/run-1.json" } as never],
          hasMore: true,
          cursor: "cursor-1",
        } as never)
        .mockResolvedValueOnce({
          blobs: [{ url: "https://blob.example/runs/run-2.json" } as never],
          hasMore: false,
        } as never);

      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({
            text: async () => JSON.stringify(makeRun("run-1", "2026-07-01T00:00:00.000Z")),
          })
          .mockResolvedValueOnce({
            text: async () => JSON.stringify(makeRun("run-2", "2026-07-02T00:00:00.000Z")),
          }),
      );

      const result = await storage.listRuns();

      expect(result.map((r) => r.id).sort()).toEqual(["run-1", "run-2"]);
      expect(list).toHaveBeenCalledTimes(2);

      vi.unstubAllGlobals();
    });

    it("getStorage throws when STORAGE is set to a non-memory value and no token is present", () => {
      // Guards against a naive fix like `if (process.env.STORAGE) return new MemoryStorage()`
      // that treats any truthy STORAGE value as "use memory" instead of
      // requiring the exact value "memory".
      const originalStorage = process.env.STORAGE;
      const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
      process.env.STORAGE = "postgres";
      delete process.env.BLOB_READ_WRITE_TOKEN;

      try {
        expect(() => getStorage()).toThrow(
          "storage misconfigured: set BLOB_READ_WRITE_TOKEN or STORAGE=memory",
        );
      } finally {
        if (originalStorage === undefined) delete process.env.STORAGE;
        else process.env.STORAGE = originalStorage;
        if (originalToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
        else process.env.BLOB_READ_WRITE_TOKEN = originalToken;
      }
    });
  });
});

describe("incremental event reads (?since= cursor)", () => {
  // This block is top-level, so it does NOT inherit the BlobStorage suite's
  // mock reset -- without these, a leftover `list` mock or stubbed global
  // fetch from another test leaks in and makes these order-dependent.
  beforeEach(() => {
    vi.mocked(get).mockReset();
    vi.mocked(put).mockReset();
    vi.mocked(list).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("seqFromEventPathname", () => {
    it("reads the seq out of a zero-padded event blob name", () => {
      expect(seqFromEventPathname("events/run-1/0000000007.json")).toBe(7);
      expect(seqFromEventPathname("events/run-1/0000000042.json")).toBe(42);
    });

    it("returns null for a name that isn't an event blob, so callers keep it rather than dropping it", () => {
      expect(seqFromEventPathname("events/run-1/weird-name.json")).toBeNull();
      expect(seqFromEventPathname("runs/run-1.json")).toBeNull();
      expect(seqFromEventPathname(undefined)).toBeNull();
      expect(seqFromEventPathname("events/run-1/9007199254740992.json")).toBeNull();
    });
  });

  it("MemoryStorage returns only events after the cursor", async () => {
    const storage = new MemoryStorage();
    await storage.appendRunEvents("run-1", [
      { ts: "2026-07-21T00:00:00.000Z", type: "run.created", payload: {} },
      { ts: "2026-07-21T00:00:01.000Z", type: "run.sandbox_ready", payload: {} },
      { ts: "2026-07-21T00:00:02.000Z", type: "run.completed", payload: {} },
    ]);

    expect((await storage.listRunEventsSince("run-1", 0)).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await storage.listRunEventsSince("run-1", 2)).map((e) => e.seq)).toEqual([3]);
    expect(await storage.listRunEventsSince("run-1", 3)).toEqual([]);
    // Unchanged full-listing behavior.
    expect((await storage.listRunEvents("run-1")).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("BlobStorage fetches ONLY the blobs after the cursor -- the whole point (no O(events) refetch per poll)", async () => {
    const storage = new BlobStorage();
    vi.mocked(list).mockResolvedValueOnce({
      blobs: [1, 2, 3, 4].map((n) => ({
        url: `https://blob.example/events/run-1/${String(n).padStart(10, "0")}.json`,
        pathname: `events/run-1/${String(n).padStart(10, "0")}.json`,
      })),
      hasMore: false,
    } as never);

    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      const seq = Number(/(\d+)\.json$/.exec(url)![1]);
      return Promise.resolve({
        text: async () => JSON.stringify({ run_id: "run-1", seq, ts: "2026-07-21T00:00:00.000Z", type: "task.started", payload: {} }),
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const events = await storage.listRunEventsSince("run-1", 2);

    expect(events.map((e) => e.seq)).toEqual([3, 4]);
    // 2 content fetches, not 4: seq 1 and 2 were excluded from the blob NAME
    // alone, before any network read.
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it("BlobStorage stops at a transiently-unreadable event instead of advancing the cursor past it", async () => {
    // The regression this guards: with a cursor, returning seq 4 while seq 3
    // merely failed to read means the caller resumes at 4 and never sees 3
    // again. Before the cursor existed a full refetch self-healed this.
    const storage = new BlobStorage();
    vi.mocked(list).mockResolvedValueOnce({
      blobs: [1, 2, 3, 4].map((n) => ({
        url: `https://blob.example/events/run-1/${String(n).padStart(10, "0")}.json`,
        pathname: `events/run-1/${String(n).padStart(10, "0")}.json`,
      })),
      hasMore: false,
    } as never);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const seq = Number(/(\d+)\.json$/.exec(url)![1]);
        // seq 3 is present in the listing but unreadable this poll.
        if (seq === 3) return Promise.resolve({ ok: false, status: 403, text: async () => "<!DOCTYPE html>" });
        return Promise.resolve({
          text: async () =>
            JSON.stringify({ run_id: "run-1", seq, ts: "2026-07-21T00:00:00.000Z", type: "task.started", payload: {} }),
        });
      }),
    );

    const events = await storage.listRunEventsSince("run-1", 0);

    // 4 is withheld even though it read fine -- the caller's next cursor must
    // not jump past 3.
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("BlobStorage does NOT stall on a permanent gap (a seq with no blob at all)", async () => {
    // appendRunEvents advances seq on a write collision, so a missing seq can
    // be permanent. Blocking on it would freeze the cursor there forever.
    const storage = new BlobStorage();
    vi.mocked(list).mockResolvedValueOnce({
      blobs: [1, 2, 4, 5].map((n) => ({
        url: `https://blob.example/events/run-1/${String(n).padStart(10, "0")}.json`,
        pathname: `events/run-1/${String(n).padStart(10, "0")}.json`,
      })),
      hasMore: false,
    } as never);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const seq = Number(/(\d+)\.json$/.exec(url)![1]);
        return Promise.resolve({
          text: async () =>
            JSON.stringify({ run_id: "run-1", seq, ts: "2026-07-21T00:00:00.000Z", type: "task.started", payload: {} }),
        });
      }),
    );

    const events = await storage.listRunEventsSince("run-1", 0);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 4, 5]);
  });

  it("BlobStorage keeps an unparseable blob name (fail-open) rather than silently dropping it", async () => {
    const storage = new BlobStorage();
    vi.mocked(list).mockResolvedValueOnce({
      blobs: [
        { url: "https://blob.example/events/run-1/0000000001.json", pathname: "events/run-1/0000000001.json" },
        { url: "https://blob.example/events/run-1/odd.json", pathname: "events/run-1/odd.json" },
      ],
      hasMore: false,
    } as never);

    const fetchSpy = vi.fn().mockImplementation((url: string) =>
      Promise.resolve({
        text: async () =>
          JSON.stringify({
            run_id: "run-1",
            seq: url.includes("odd") ? 9 : 1,
            ts: "2026-07-21T00:00:00.000Z",
            type: "task.started",
            payload: {},
          }),
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    // Cursor 5 excludes seq 1 by name; the unparseable blob is still fetched,
    // and its real seq (9) is what decides whether it's returned.
    const events = await storage.listRunEventsSince("run-1", 5);
    expect(events.map((e) => e.seq)).toEqual([9]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});

describe("partial reads fail loud (regression: fabricated leaderboard standings)", () => {
  beforeEach(() => {
    vi.mocked(get).mockReset();
    vi.mocked(put).mockReset();
    vi.mocked(list).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function blobs(prefix: string, ids: string[]) {
    return {
      blobs: ids.map((id) => ({ url: `https://blob.example/${prefix}${id}.json`, pathname: `${prefix}${id}.json` })),
      hasMore: false,
    } as never;
  }

  // Rate-limited Blob reads return an HTML error page, not JSON.
  function fetchWhereOneFails(failingId: string, build: (id: string) => object) {
    return vi.fn().mockImplementation((url: string) => {
      const id = /\/([^/]+)\.json$/.exec(url)![1];
      if (id === failingId) {
        return Promise.resolve({ ok: false, status: 403, text: async () => "<!DOCTYPE html>Forbidden" });
      }
      return Promise.resolve({ text: async () => JSON.stringify(build(id)) });
    });
  }

  const run = (id: string) => ({ id, submission_id: `sub-${id}`, status: "completed", task_results: [], created_at: "2026-07-21T00:00:00.000Z" });
  const sub = (id: string) => ({ id, agent_name: "a", prompt: "p", status: "scored", created_at: "2026-07-21T00:00:00.000Z" });

  it("listRuns THROWS when a run blob is unreadable, rather than returning a smaller list", async () => {
    // The incident: a dropped run silently changes every aggregate computed
    // from this list -- pass rate, run count, cost -- with no error anywhere.
    const storage = new BlobStorage();
    vi.mocked(list).mockResolvedValue(blobs("runs/", ["r1", "r2", "r3"]));
    vi.stubGlobal("fetch", fetchWhereOneFails("r2", run));

    await expect(storage.listRuns()).rejects.toThrow(PartialReadError);
    await expect(storage.listRuns()).rejects.toThrow(/1 of 3/);
  });

  it("listCompetitions THROWS when a competition blob is unreadable, same as listSubmissions/listRuns", async () => {
    // Same partial-read contract as submissions/runs -- see storage.ts comment
    // on Storage.listCompetitions.
    const storage = new BlobStorage();
    const competition = (id: string) => makeCompetition(id);
    vi.mocked(list).mockResolvedValue(blobs("competitions/", ["c1", "c2"]));
    vi.stubGlobal("fetch", fetchWhereOneFails("c2", competition));

    await expect(storage.listCompetitions()).rejects.toThrow(PartialReadError);
    await expect(storage.listCompetitions()).rejects.toThrow(/1 of 2/);
  });

  it("listSubmissions THROWS when a submission blob is unreadable", async () => {
    // This is the one that fabricated standings: aggregatePrompts keys a run
    // whose submission is missing as `__unknown:<runId>` -- unique per run --
    // so each orphan became its own bogus one-run standing labelled "unknown".
    const storage = new BlobStorage();
    vi.mocked(list).mockResolvedValueOnce(blobs("submissions/", ["s1", "s2"]));
    vi.stubGlobal("fetch", fetchWhereOneFails("s2", sub));

    await expect(storage.listSubmissions()).rejects.toThrow(PartialReadError);
  });

  it("still returns the full list when every blob reads cleanly", async () => {
    const storage = new BlobStorage();
    vi.mocked(list).mockResolvedValue(blobs("runs/", ["r1", "r2", "r3"]));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const id = /\/([^/]+)\.json$/.exec(url)![1];
        return Promise.resolve({ text: async () => JSON.stringify(run(id)) });
      }),
    );

    expect((await storage.listRuns()).map((r) => r.id).sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("carries the missing/total counts so an operator can see how bad it is", async () => {
    const storage = new BlobStorage();
    vi.mocked(list).mockResolvedValueOnce(blobs("runs/", ["r1", "r2"]));
    vi.stubGlobal("fetch", fetchWhereOneFails("r1", run));

    await storage.listRuns().then(
      () => { throw new Error("expected a throw"); },
      (err) => {
        expect(err).toBeInstanceOf(PartialReadError);
        expect(err.prefix).toBe("runs/");
        expect(err.missing).toBe(1);
        expect(err.total).toBe(2);
      },
    );
  });
});
