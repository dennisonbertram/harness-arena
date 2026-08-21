import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "./storage";
import { getTasks } from "./tasks";
import { reapIfStale, reapStaleRuns, shouldReap } from "./reaper";
import type { Run } from "./types";

const MAX_TASK_QUIET_MINUTES = Math.ceil(
  Math.max(...getTasks().map((task) => task.agentTimeoutSec + task.verifierTimeoutSec)) / 60,
);
const DEFAULT_REAP_STALE_MINUTES =
  Math.ceil((MAX_TASK_QUIET_MINUTES + 10) / 10) * 10;
const DEFAULT_REAP_STALE_MS = DEFAULT_REAP_STALE_MINUTES * 60 * 1000;

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    submission_id: "sub-1",
    status: "queued",
    task_results: [],
    created_at: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("shouldReap (pure)", () => {
  it("is true for a dispatched queued run silent beyond the task-derived stale window", () => {
    const run = makeRun({ status: "queued", dispatched_at: "2026-07-21T00:00:00.000Z" });
    const lastEventTs = "2026-07-21T00:00:00.000Z";
    const now = new Date(lastEventTs).getTime() + DEFAULT_REAP_STALE_MS + 1000;
    expect(shouldReap(run, lastEventTs, now)).toBe(true);
  });

  it("is false for an UNDISPATCHED queued run no matter how old (waiting for a slot, not stuck)", () => {
    const run = makeRun({ status: "queued" }); // no dispatched_at
    expect(shouldReap(run, "2020-01-01T00:00:00.000Z", Date.now())).toBe(false);
  });

  it("is false for a just-dispatched queued run whose last EVENT is old (dispatch resets the clock)", () => {
    const lastEventTs = "2026-07-21T00:00:00.000Z"; // old: the run waited in the queue
    const now = new Date(lastEventTs).getTime() + DEFAULT_REAP_STALE_MS + 5000;
    // Claimed a second ago -> its sandbox is spinning up; must not be reaped yet.
    const run = makeRun({ status: "queued", dispatched_at: new Date(now - 1000).toISOString() });
    expect(shouldReap(run, lastEventTs, now)).toBe(false);
  });

  it("is true for a running run whose last event is beyond the task-derived stale window", () => {
    const run = makeRun({ status: "running" });
    const lastEventTs = "2026-07-21T00:00:00.000Z";
    const now = new Date(lastEventTs).getTime() + DEFAULT_REAP_STALE_MS + 1;
    expect(shouldReap(run, lastEventTs, now)).toBe(true);
  });

  it("is false throughout the maximum task quiet window plus safety margin", () => {
    const run = makeRun({ status: "running" });
    const lastEventTs = "2026-07-21T00:00:00.000Z";
    const now = new Date(lastEventTs).getTime() + DEFAULT_REAP_STALE_MS - 1000;
    expect(shouldReap(run, lastEventTs, now)).toBe(false);
  });

  it("is false for a completed run no matter how stale", () => {
    const run = makeRun({ status: "completed" });
    expect(shouldReap(run, "2020-01-01T00:00:00.000Z", Date.now())).toBe(false);
  });

  it("is false for a failed run no matter how stale", () => {
    const run = makeRun({ status: "failed" });
    expect(shouldReap(run, "2020-01-01T00:00:00.000Z", Date.now())).toBe(false);
  });

  it("is false for an already-reaped run", () => {
    const run = makeRun({ status: "reaped" });
    expect(shouldReap(run, "2020-01-01T00:00:00.000Z", Date.now())).toBe(false);
  });
});

describe("reapIfStale (integration against MemoryStorage)", () => {
  it("marks a stale dispatched-queued run reaped and appends a run.reaped event", async () => {
    const storage = new MemoryStorage();
    // Dispatched (claimed) but its sandbox stalled -> a real stuck run to reap.
    const run = makeRun({
      status: "queued",
      dispatched_at: "2026-07-21T00:00:00.000Z",
      created_at: "2026-07-21T00:00:00.000Z",
    });
    await storage.putRun(run);

    const now = new Date(run.created_at).getTime() + DEFAULT_REAP_STALE_MS + 60 * 1000;
    const result = await reapIfStale(storage, run, now);

    expect(result.status).toBe("reaped");
    const stored = await storage.getRun(run.id);
    expect(stored?.status).toBe("reaped");

    const events = await storage.listRunEvents(run.id);
    expect(events.some((e) => e.type === "run.reaped")).toBe(true);
  });

  it("marks the parent submission failed when its stale run is reaped", async () => {
    const storage = new MemoryStorage();
    const run = makeRun({ status: "running" });
    await storage.putRun(run);
    await storage.putSubmission({
      id: run.submission_id,
      agent_name: "stalled agent",
      prompt: "p",
      status: "running",
      run_id: run.id,
      created_at: run.created_at,
    });

    await reapIfStale(
      storage,
      run,
      new Date(run.created_at).getTime() + DEFAULT_REAP_STALE_MS + 60 * 1000,
    );

    expect((await storage.getSubmission(run.submission_id))?.status).toBe("failed");
  });

  it("repairs a stale parent status when the run was already reaped", async () => {
    const storage = new MemoryStorage();
    const run = makeRun({ status: "reaped", finished_at: "2026-07-21T00:21:00.000Z" });
    await storage.putRun(run);
    await storage.putSubmission({
      id: run.submission_id,
      agent_name: "stalled agent",
      prompt: "p",
      status: "running",
      run_id: run.id,
      created_at: run.created_at,
    });

    await reapIfStale(storage, run);

    expect((await storage.getSubmission(run.submission_id))?.status).toBe("failed");
  });

  it("repairs a stale parent status when sandbox creation already marked the run failed", async () => {
    const storage = new MemoryStorage();
    const run = makeRun({ status: "failed", finished_at: "2026-07-21T00:01:00.000Z" });
    await storage.putRun(run);
    await storage.putSubmission({
      id: run.submission_id,
      agent_name: "never started",
      prompt: "p",
      status: "queued",
      run_id: run.id,
      created_at: run.created_at,
    });

    await reapIfStale(storage, run);

    expect((await storage.getSubmission(run.submission_id))?.status).toBe("failed");
  });

  it("uses the timestamp of the most recent event, not created_at, once events exist", async () => {
    const storage = new MemoryStorage();
    const run = makeRun({ status: "running", created_at: "2026-07-21T00:00:00.000Z" });
    await storage.putRun(run);
    await storage.appendRunEvents(run.id, [
      { ts: "2026-07-21T00:10:00.000Z", type: "task.started", payload: {} },
    ]);

    // Still under the task-derived threshold measured from the last event, so this must
    // NOT be reaped even though created_at alone would look stale.
    const now = new Date("2026-07-21T00:10:00.000Z").getTime() + DEFAULT_REAP_STALE_MS - 1000;
    const result = await reapIfStale(storage, run, now);

    expect(result.status).toBe("running");
  });

  it("leaves a completed run untouched even if it has been stale for days", async () => {
    const storage = new MemoryStorage();
    const run = makeRun({ status: "completed", created_at: "2020-01-01T00:00:00.000Z" });
    await storage.putRun(run);

    const result = await reapIfStale(storage, run, Date.now());

    expect(result.status).toBe("completed");
    const events = await storage.listRunEvents(run.id);
    expect(events).toHaveLength(0);
  });
});

describe("reapStaleRuns (sweep all runs)", () => {
  it("reaps every stale queued/running run and leaves fresh/terminal runs alone", async () => {
    const storage = new MemoryStorage();
    const now = new Date("2026-07-21T01:00:00.000Z").getTime();
    const staleCreatedAt = new Date(now - DEFAULT_REAP_STALE_MS - 1000).toISOString();
    const freshCreatedAt = new Date(now - DEFAULT_REAP_STALE_MS + 1000).toISOString();
    const stale = makeRun({ id: "stale-1", status: "running", created_at: staleCreatedAt });
    const fresh = makeRun({ id: "fresh-1", status: "running", created_at: freshCreatedAt });
    const done = makeRun({ id: "done-1", status: "completed", created_at: "2020-01-01T00:00:00.000Z" });
    await storage.putRun(stale);
    await storage.putRun(fresh);
    await storage.putRun(done);

    const reaped = await reapStaleRuns(storage, now);

    expect(reaped.map((r) => r.id)).toEqual(["stale-1"]);
    expect((await storage.getRun("stale-1"))?.status).toBe("reaped");
    expect((await storage.getRun("fresh-1"))?.status).toBe("running");
    expect((await storage.getRun("done-1"))?.status).toBe("completed");
  });
});

describe("regression: reaping is idempotent", () => {
  it("running reapIfStale twice on an already-reaped run does not append a second run.reaped event", async () => {
    const storage = new MemoryStorage();
    const run = makeRun({ status: "running", created_at: "2026-07-21T00:00:00.000Z" });
    await storage.putRun(run);
    const now = new Date(run.created_at).getTime() + DEFAULT_REAP_STALE_MS + 1000;

    await reapIfStale(storage, run, now);
    const reapedRun = (await storage.getRun(run.id))!;
    await reapIfStale(storage, reapedRun, now + 1000);

    const events = await storage.listRunEvents(run.id);
    expect(events.filter((e) => e.type === "run.reaped")).toHaveLength(1);
  });
});

describe("regression: reap must not clobber a concurrent terminal callback", () => {
  it("leaves a run that completed between the staleness check and the reap write as completed", async () => {
    const storage = new MemoryStorage();
    const run = makeRun({ status: "running", created_at: "2026-07-21T00:00:00.000Z" });
    await storage.putRun(run);

    // Simulate the runner's terminal callback landing while the reaper is
    // between its staleness probe and its write: the moment the reaper reads
    // event timestamps, the run completes underneath it.
    const originalLatest = storage.latestEventTimestamp.bind(storage);
    storage.latestEventTimestamp = async (id: string) => {
      const ts = await originalLatest(id);
      await storage.putRun({
        ...run,
        status: "completed",
        finished_at: "2026-07-21T00:30:00.000Z",
      });
      return ts;
    };

    const now = new Date(run.created_at).getTime() + DEFAULT_REAP_STALE_MS + 60 * 1000;
    const result = await reapIfStale(storage, run, now);

    expect(result.status).toBe("completed");
    const stored = await storage.getRun(run.id);
    expect(stored?.status).toBe("completed");
    const events = await storage.listRunEvents(run.id);
    expect(events.some((e) => e.type === "run.reaped")).toBe(false);
  });
});

describe("regression: submission only fails when ALL of its runs are terminal", () => {
  it("does not flip the submission to failed while a sibling run is still executing", async () => {
    const storage = new MemoryStorage();
    const staleCreated = "2026-07-21T00:00:00.000Z";
    const staleA = makeRun({ id: "run-a", status: "running", created_at: staleCreated });
    const staleB = makeRun({ id: "run-b", status: "running", created_at: staleCreated });
    await storage.putRun(staleA);
    await storage.putRun(staleB);
    await storage.putSubmission({
      id: "sub-1",
      agent_name: "multi-run agent",
      prompt: "p",
      status: "running",
      run_id: staleA.id,
      created_at: staleCreated,
    });

    const now = new Date(staleCreated).getTime() + DEFAULT_REAP_STALE_MS + 60 * 1000;

    // First run reaped: sibling run-b is still executing, so the parent
    // submission must stay active.
    await reapIfStale(storage, staleA, now);
    expect((await storage.getSubmission("sub-1"))?.status).toBe("running");

    // Only once every run of the submission is terminal does it fail.
    await reapIfStale(storage, staleB, now);
    expect((await storage.getSubmission("sub-1"))?.status).toBe("failed");
  });

  it("still fails the submission when its single stale run is reaped", async () => {
    const storage = new MemoryStorage();
    const run = makeRun({ status: "running", created_at: "2026-07-21T00:00:00.000Z" });
    await storage.putRun(run);
    await storage.putSubmission({
      id: run.submission_id,
      agent_name: "solo agent",
      prompt: "p",
      status: "running",
      run_id: run.id,
      created_at: run.created_at,
    });

    await reapIfStale(
      storage,
      run,
      new Date(run.created_at).getTime() + DEFAULT_REAP_STALE_MS + 60 * 1000,
    );

    expect((await storage.getSubmission(run.submission_id))?.status).toBe("failed");
  });
});

describe("regression: REAP_STALE_MINUTES env override (issue #23 finding F)", () => {
  const ORIGINAL = process.env.REAP_STALE_MINUTES;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.REAP_STALE_MINUTES;
    else process.env.REAP_STALE_MINUTES = ORIGINAL;
  });

  beforeEach(() => {
    delete process.env.REAP_STALE_MINUTES;
  });

  it("honors REAP_STALE_MINUTES=1 instead of the task-derived default (read per-call, not cached at import)", () => {
    process.env.REAP_STALE_MINUTES = "1";

    const run = makeRun({ status: "running" });
    const lastEventTs = "2026-07-21T00:00:00.000Z";
    const now = new Date(lastEventTs).getTime() + 61 * 1000;

    expect(shouldReap(run, lastEventTs, now)).toBe(true);
  });
});
