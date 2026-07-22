import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "./storage";
import { reapIfStale, reapStaleRuns, shouldReap } from "./reaper";
import type { Run } from "./types";

const TWENTY_MIN_MS = 20 * 60 * 1000;

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
  it("is true for a queued run whose last event is over 20 minutes old", () => {
    const run = makeRun({ status: "queued" });
    const lastEventTs = "2026-07-21T00:00:00.000Z";
    const now = new Date(lastEventTs).getTime() + TWENTY_MIN_MS + 1000;
    expect(shouldReap(run, lastEventTs, now)).toBe(true);
  });

  it("is true for a running run whose last event is over 20 minutes old", () => {
    const run = makeRun({ status: "running" });
    const lastEventTs = "2026-07-21T00:00:00.000Z";
    const now = new Date(lastEventTs).getTime() + TWENTY_MIN_MS + 1;
    expect(shouldReap(run, lastEventTs, now)).toBe(true);
  });

  it("is false when the last event is under 20 minutes old", () => {
    const run = makeRun({ status: "running" });
    const lastEventTs = "2026-07-21T00:00:00.000Z";
    const now = new Date(lastEventTs).getTime() + TWENTY_MIN_MS - 1000;
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
  it("marks a stale queued run reaped and appends a run.reaped event", async () => {
    const storage = new MemoryStorage();
    const run = makeRun({ status: "queued", created_at: "2026-07-21T00:00:00.000Z" });
    await storage.putRun(run);

    const now = new Date("2026-07-21T00:21:00.000Z").getTime();
    const result = await reapIfStale(storage, run, now);

    expect(result.status).toBe("reaped");
    const stored = await storage.getRun(run.id);
    expect(stored?.status).toBe("reaped");

    const events = await storage.listRunEvents(run.id);
    expect(events.some((e) => e.type === "run.reaped")).toBe(true);
  });

  it("uses the timestamp of the most recent event, not created_at, once events exist", async () => {
    const storage = new MemoryStorage();
    const run = makeRun({ status: "running", created_at: "2026-07-21T00:00:00.000Z" });
    await storage.putRun(run);
    await storage.appendRunEvents(run.id, [
      { ts: "2026-07-21T00:10:00.000Z", type: "task.started", payload: {} },
    ]);

    // 11 minutes after the last event (21 after created_at) -- still under
    // the 20-minute threshold measured from the last event, so this must
    // NOT be reaped even though created_at alone would look stale.
    const now = new Date("2026-07-21T00:21:00.000Z").getTime();
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
    const stale = makeRun({ id: "stale-1", status: "running", created_at: "2026-07-21T00:00:00.000Z" });
    const fresh = makeRun({ id: "fresh-1", status: "running", created_at: "2026-07-21T00:19:00.000Z" });
    const done = makeRun({ id: "done-1", status: "completed", created_at: "2020-01-01T00:00:00.000Z" });
    await storage.putRun(stale);
    await storage.putRun(fresh);
    await storage.putRun(done);

    const now = new Date("2026-07-21T00:21:00.000Z").getTime();
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
    const now = new Date("2026-07-21T00:21:00.000Z").getTime();

    await reapIfStale(storage, run, now);
    const reapedRun = (await storage.getRun(run.id))!;
    await reapIfStale(storage, reapedRun, now + 1000);

    const events = await storage.listRunEvents(run.id);
    expect(events.filter((e) => e.type === "run.reaped")).toHaveLength(1);
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

  it("honors REAP_STALE_MINUTES=1 instead of the 20-minute default (read per-call, not cached at import)", () => {
    process.env.REAP_STALE_MINUTES = "1";

    const run = makeRun({ status: "running" });
    const lastEventTs = "2026-07-21T00:00:00.000Z";
    const now = new Date(lastEventTs).getTime() + 61 * 1000;

    expect(shouldReap(run, lastEventTs, now)).toBe(true);
  });
});
