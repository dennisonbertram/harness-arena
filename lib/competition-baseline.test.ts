import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/judge", () => ({ judgeSubmission: vi.fn(), JUDGE_MODEL: "anthropic/claude-sonnet-5" }));
vi.mock("@/lib/run-trigger", () => ({ startRun: vi.fn().mockResolvedValue(undefined) }));

import { judgeSubmission } from "@/lib/judge";
import { ensureBaseline, ensureBaselines } from "./competition-baseline";
import { MemoryStorage } from "./storage";
import type { Competition, Run, Submission } from "./types";

function competition(id: string, overrides: Partial<Competition> = {}): Competition {
  return {
    id,
    arena: "harness-arena",
    harness: "pi",
    model: "zai/glm-5.2",
    prize_amount_usd: null,
    prize_cadence: null,
    status: "live",
    created_at: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

function approve() {
  vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "approved", reason: "fair" });
}

async function baselinesFor(storage: MemoryStorage, competitionId: string): Promise<Submission[]> {
  return (await storage.listSubmissions()).filter(
    (s) => s.competition_baseline === true && s.competition_id === competitionId,
  );
}

beforeEach(() => {
  vi.mocked(judgeSubmission).mockReset();
});

describe("ensureBaseline", () => {
  it("creates a baseline for a competition that has none", async () => {
    approve();
    const storage = new MemoryStorage();
    const comp = competition("comp-1", { gateway_provider: "morph" });
    await storage.putCompetition(comp);

    const result = await ensureBaseline(storage, comp);

    expect(result.kind).toBe("created");
    const baselines = await baselinesFor(storage, "comp-1");
    expect(baselines).toHaveLength(1);
    // The baseline must run on the COMPETITION's model, not a global default,
    // or the reference point is measured against the wrong thing.
    expect(baselines[0].model).toBe("zai/glm-5.2");
    // Provider is part of the measurement target too. A new competition's
    // vanilla baseline must use the same upstream as its entrants.
    expect(baselines[0].gateway_provider).toBe("morph");
  });

  // The whole design rests on this: the trigger is best-effort and the board
  // render calls it on every view, so a second call must be a no-op rather
  // than a second paid run.
  it("is idempotent — a second call creates nothing", async () => {
    approve();
    const storage = new MemoryStorage();
    const comp = competition("comp-1");
    await storage.putCompetition(comp);

    const first = await ensureBaseline(storage, comp);
    const second = await ensureBaseline(storage, comp);

    expect(first.kind).toBe("created");
    expect(second.kind).toBe("already_present");
    expect(await baselinesFor(storage, "comp-1")).toHaveLength(1);
  });

  it("retries when the previous baseline's run infra-failed", async () => {
    approve();
    const storage = new MemoryStorage();
    const comp = competition("comp-1");
    await storage.putCompetition(comp);
    await ensureBaseline(storage, comp);

    // Simulate the sandbox dying rather than the agent failing the tasks: an
    // infra failure is nobody's fault and must not leave the competition
    // permanently without a reference point.
    const [existing] = await baselinesFor(storage, "comp-1");
    const run = (await storage.getRun(existing.run_id!)) as Run;
    await storage.putRun({ ...run, status: "reaped" });

    const result = await ensureBaseline(storage, comp);

    expect(result.kind).toBe("created");
    expect(await baselinesFor(storage, "comp-1")).toHaveLength(2);
  });

  it("retries when a completed baseline contains only provider transport failures", async () => {
    approve();
    const storage = new MemoryStorage();
    const comp = competition("comp-1");
    await storage.putCompetition(comp);
    await ensureBaseline(storage, comp);

    // The runner deliberately continues after task-level failures, so broken
    // model plumbing can still produce a formally "completed" 0/16 run. That
    // is infrastructure evidence, not a legitimate reference score.
    const [existing] = await baselinesFor(storage, "comp-1");
    const run = (await storage.getRun(existing.run_id!)) as Run;
    await storage.putRun({
      ...run,
      status: "completed",
      tasks_passed: 0,
      task_results: [
        {
          task_id: "task-a",
          attempted: true,
          passed: false,
          turns: 1,
          failure_stage: "provider_error",
          error: "404 /v1/v1/messages",
        },
        {
          task_id: "task-b",
          attempted: true,
          passed: false,
          turns: 1,
          failure_stage: "provider_timeout",
          error: "upstream timed out",
        },
      ],
    });

    const result = await ensureBaseline(storage, comp);

    expect(result.kind).toBe("created");
    expect(await baselinesFor(storage, "comp-1")).toHaveLength(2);
  });

  it("does not create a second baseline for a competition whose baseline is healthy", async () => {
    approve();
    const storage = new MemoryStorage();
    const a = competition("comp-a");
    const b = competition("comp-b", { model: "anthropic/claude-opus-5" });
    await storage.putCompetition(a);
    await storage.putCompetition(b);

    await ensureBaseline(storage, a);
    await ensureBaseline(storage, b);
    await ensureBaseline(storage, a);

    expect(await baselinesFor(storage, "comp-a")).toHaveLength(1);
    expect(await baselinesFor(storage, "comp-b")).toHaveLength(1);
  });

  // Caught in a live smoke, not by the original unit tests: when the judge is
  // unavailable, judgeAndDispatch returns early and LEAVES the submission
  // stored as pending_review with no run. The predicate treated "no run" as
  // non-blocking, so every sweep -- and the board render calls this on every
  // view -- created another orphan. Unbounded.
  it("does not pile up orphans when the judge is unavailable", async () => {
    vi.mocked(judgeSubmission).mockRejectedValue(new Error("judge upstream 500"));
    const storage = new MemoryStorage();
    const comp = competition("comp-1");
    await storage.putCompetition(comp);

    await ensureBaseline(storage, comp);
    await ensureBaseline(storage, comp);
    await ensureBaseline(storage, comp);

    expect(await baselinesFor(storage, "comp-1")).toHaveLength(1);
  });

  it("allows a retry once a stuck pending baseline has gone stale", async () => {
    vi.mocked(judgeSubmission).mockRejectedValueOnce(new Error("judge upstream 500"));
    const storage = new MemoryStorage();
    const comp = competition("comp-1");
    await storage.putCompetition(comp);
    await ensureBaseline(storage, comp);

    // Age the orphan past the in-flight window: a judge outage must not block
    // the competition from ever getting a baseline.
    const [stuck] = await baselinesFor(storage, "comp-1");
    await storage.putSubmission({ ...stuck, created_at: "2020-01-01T00:00:00.000Z" });

    approve();
    const result = await ensureBaseline(storage, comp);

    expect(result.kind).toBe("created");
  });

  it("reports a judge outage without leaving a dispatched run", async () => {
    vi.mocked(judgeSubmission).mockRejectedValue(new Error("judge upstream 500"));
    const storage = new MemoryStorage();
    const comp = competition("comp-1");
    await storage.putCompetition(comp);

    const result = await ensureBaseline(storage, comp);

    expect(result.kind).toBe("judge_unavailable");
    expect(await storage.listRuns()).toHaveLength(0);
  });

  // Deliberate trade-off: an outage leaves ONE in-flight orphan that blocks
  // immediate retries, bounding the leak. The retry comes once it goes stale
  // (covered above), so the cost of a judge blip is a delayed baseline rather
  // than a pile of submissions.
  it("does not retry immediately after a judge outage — the in-flight attempt blocks", async () => {
    const storage = new MemoryStorage();
    const comp = competition("comp-1");
    await storage.putCompetition(comp);
    vi.mocked(judgeSubmission).mockRejectedValueOnce(new Error("judge upstream 500"));
    await ensureBaseline(storage, comp);

    approve();
    const result = await ensureBaseline(storage, comp);

    expect(result.kind).toBe("already_present");
    expect(await baselinesFor(storage, "comp-1")).toHaveLength(1);
  });
});

describe("automatic reconciliation is bounded", () => {
  // skip_baseline suppressed only the create route's own callback; the flag
  // was never stored, so the board render and cron recreated the baseline the
  // admin explicitly declined to pay for.
  it("honours a competition that opted out of an automatic baseline", async () => {
    approve();
    const storage = new MemoryStorage();
    await storage.putCompetition(competition("comp-opted-out", { auto_baseline: false }));

    const results = await ensureBaselines(storage);

    expect(results).toHaveLength(0);
    expect(await baselinesFor(storage, "comp-opted-out")).toHaveLength(0);
  });

  // A rejected baseline means the fixed vanilla prompt failed the fairness
  // judge -- a systemic problem needing a human, not something to retry. The
  // predicate treated rejected as absent, so every board render stored another
  // rejected submission AND burned another judge call, forever.
  it("does not automatically retry a judge-rejected baseline", async () => {
    const storage = new MemoryStorage();
    const comp = competition("comp-1");
    await storage.putCompetition(comp);
    vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "rejected", reason: "nope" });

    await ensureBaseline(storage, comp);
    await ensureBaseline(storage, comp);
    await ensureBaseline(storage, comp);

    expect(await baselinesFor(storage, "comp-1")).toHaveLength(1);
    expect(vi.mocked(judgeSubmission)).toHaveBeenCalledTimes(1);
  });

  // The admin route is a human deliberately retrying, so it may override.
  it("lets an explicit caller retry past a rejection", async () => {
    const storage = new MemoryStorage();
    const comp = competition("comp-1");
    await storage.putCompetition(comp);
    vi.mocked(judgeSubmission).mockResolvedValueOnce({ verdict: "rejected", reason: "nope" });
    await ensureBaseline(storage, comp);

    approve();
    const result = await ensureBaseline(storage, comp, { retryAfterRejection: true });

    expect(result.kind).toBe("created");
  });

  // after() fires on every render, so two can overlap on one instance.
  it("does not double-create when two ensure calls overlap", async () => {
    approve();
    const storage = new MemoryStorage();
    const comp = competition("comp-1");
    await storage.putCompetition(comp);

    await Promise.all([ensureBaseline(storage, comp), ensureBaseline(storage, comp)]);

    expect(await baselinesFor(storage, "comp-1")).toHaveLength(1);
  });
});

describe("ensureBaselines", () => {
  it("covers every live competition in one sweep", async () => {
    approve();
    const storage = new MemoryStorage();
    await storage.putCompetition(competition("comp-a"));
    await storage.putCompetition(competition("comp-b"));

    const results = await ensureBaselines(storage);

    expect(results.filter((r) => r.kind === "created")).toHaveLength(2);
  });

  // Closing a competition ends it. A closed board resurrecting baseline runs
  // would spend money on a finished contest.
  it("skips closed competitions", async () => {
    approve();
    const storage = new MemoryStorage();
    await storage.putCompetition(competition("comp-closed", { status: "closed" }));

    const results = await ensureBaselines(storage);

    expect(results).toHaveLength(0);
    expect(await baselinesFor(storage, "comp-closed")).toHaveLength(0);
  });

  it("never throws when storage is unreadable — the caller is a page render", async () => {
    const storage = new MemoryStorage();
    vi.spyOn(storage, "listCompetitions").mockRejectedValue(new Error("blob unreachable"));

    await expect(ensureBaselines(storage)).resolves.toEqual([]);
  });

  it("keeps going when one competition's baseline fails", async () => {
    const storage = new MemoryStorage();
    await storage.putCompetition(competition("comp-a"));
    await storage.putCompetition(competition("comp-b"));
    vi.mocked(judgeSubmission)
      .mockRejectedValueOnce(new Error("judge upstream 500"))
      .mockResolvedValue({ verdict: "approved", reason: "fair" });

    const results = await ensureBaselines(storage);

    expect(results.map((r) => r.kind).sort()).toEqual(["created", "judge_unavailable"]);
  });
});
