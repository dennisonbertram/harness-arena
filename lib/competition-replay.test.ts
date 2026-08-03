import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { replayCompetition } from "./competition-replay";
import { normalizedPricingVersion } from "./normalized-pricing";
import { MemoryStorage, type Storage } from "./storage";
import type { Competition, Run, Submission } from "./types";

const COMPETITION_ID = "eda31800-e401-4c40-a112-b101079dd7f4";
const OPERATION_ID = "7d9437f6-02fe-4da6-8d84-791b0ecf4690";
const NOW = "2026-08-03T12:00:00.000Z";
const MODEL = "thinkingmachines/inkling-small";
const PRICING_VERSION = normalizedPricingVersion(MODEL)!;

const MANIFEST_DIGEST = createHash("sha256").update(JSON.stringify([
  { submission_id: "a", source_run_id: "old-a", baseline: false, model: MODEL, provider: null, prompt_sha256: createHash("sha256").update("prompt-a").digest("hex") },
  { submission_id: "b", source_run_id: "old-b", baseline: false, model: MODEL, provider: null, prompt_sha256: createHash("sha256").update("prompt-b").digest("hex") },
  { submission_id: "baseline", source_run_id: "old-baseline", baseline: true, model: MODEL, provider: null, prompt_sha256: createHash("sha256").update("").digest("hex") },
])).digest("hex");

type ReplayRun = Run & {
  replay_of_run_id?: string;
  replay_operation_id?: string;
};

function competition(overrides: Partial<Competition> = {}): Competition {
  return {
    id: COMPETITION_ID,
    arena: "harness-arena",
    harness: "pi",
    model: MODEL,
    pricing_version: PRICING_VERSION,
    status: "live",
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function submission(id: string, runId: string, overrides: Partial<Submission> = {}): Submission {
  return {
    id,
    agent_name: id === "baseline" ? "pi-vanilla-baseline" : `entrant-${id}`,
    prompt: id === "baseline" ? "" : `prompt-${id}`,
    status: "scored",
    competition: true,
    competition_id: COMPETITION_ID,
    competition_baseline: id === "baseline",
    model: MODEL,
    pricing_version: PRICING_VERSION,
    run_id: runId,
    run_ids: [runId],
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function completedRun(id: string, submissionId: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    submission_id: submissionId,
    status: "completed",
    model: MODEL,
    task_results: [],
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

async function seededStorage() {
  const storage = new MemoryStorage();
  await storage.putCompetition(competition());
  for (const [submissionId, runId] of [["baseline", "old-baseline"], ["a", "old-a"], ["b", "old-b"]] as const) {
    await storage.putSubmission(submission(submissionId, runId));
    await storage.putRun(completedRun(runId, submissionId));
  }
  return storage;
}

function options(confirm = false) {
  const ids = ["replay-baseline", "replay-a", "replay-b"];
  return {
    competitionId: COMPETITION_ID,
    expectedCount: ids.length,
    operationId: OPERATION_ID,
    confirm,
    manifestDigest: confirm ? MANIFEST_DIGEST : undefined,
    now: () => NOW,
    uuid: () => ids.shift()!,
  };
}

type InvalidReplayChange = {
  competition?: Partial<Competition>;
  expectedCount?: number;
  run?: Partial<Run>;
  submission?: Partial<Submission>;
};

const invalidReplayCases: Array<[string, InvalidReplayChange]> = [
  ["closed competition", { competition: { status: "closed" } }],
  ["pricing version mismatch", { competition: { pricing_version: "old-table" } }],
  ["unexpected source count", { expectedCount: 2 }],
  ["nonterminal current run", { run: { status: "running" } }],
  ["unscored source submission", { submission: { status: "rejected" } }],
];

describe("replayCompetition", () => {
  it("plans every completed source submission exactly once, including its single baseline, without writing in dry-run", async () => {
    const storage = await seededStorage();

    const plan = await replayCompetition(storage, options());

    expect(plan).toMatchObject({ confirmed: false, sourceCount: 3, plannedCount: 3, operationId: OPERATION_ID });
    expect(plan.sources.map((source: { submissionId: string }) => source.submissionId).sort()).toEqual(["a", "b", "baseline"]);
    expect(plan.sources.filter((source: { baseline: boolean }) => source.baseline)).toHaveLength(1);
    expect((await storage.listRuns()).map((run) => run.id).sort()).toEqual(["old-a", "old-b", "old-baseline"]);
    expect((await storage.getSubmission("a"))?.status).toBe("scored");
  });

  it("rejects a wrong or stale manifest digest before reserving runs or changing pointers", async () => {
    const storage = await seededStorage();
    const dryRun = await replayCompetition(storage, options());
    expect(dryRun.manifestDigest).toBe(MANIFEST_DIGEST);

    await storage.putSubmission(submission("a", "old-a", { prompt: "prompt-a changed" }));
    await expect(replayCompetition(storage, {
      ...options(true),
      manifestDigest: dryRun.manifestDigest,
    })).rejects.toThrow(/manifest/i);

    expect((await storage.listRuns()).filter((run) => run.replay_operation_id)).toHaveLength(0);
    expect((await storage.getSubmission("a"))?.run_id).toBe("old-a");
    expect((await storage.getSubmission("a"))?.status).toBe("scored");
  });

  it("creates one queued replay run per source, preserves the old runs, and atomically repoints every submission on confirmation", async () => {
    const storage = await seededStorage();

    const result = await replayCompetition(storage, options(true));

    expect(result).toMatchObject({ confirmed: true, createdCount: 3, operationId: OPERATION_ID });
    const allRuns = await storage.listRuns();
    const replayRuns = allRuns.filter((run): run is ReplayRun => "replay_operation_id" in run);
    expect(replayRuns).toHaveLength(3);
    expect(replayRuns.map((run) => run.status)).toEqual(["queued", "queued", "queued"]);
    expect(replayRuns.map((run) => [run.replay_of_run_id, run.replay_operation_id]).sort()).toEqual([
      ["old-a", OPERATION_ID],
      ["old-b", OPERATION_ID],
      ["old-baseline", OPERATION_ID],
    ]);
    expect(allRuns.filter((run) => run.id.startsWith("old-")).every((run) => run.status === "completed")).toBe(true);

    for (const [submissionId, replayId, oldId] of [["baseline", "replay-baseline", "old-baseline"], ["a", "replay-a", "old-a"], ["b", "replay-b", "old-b"]] as const) {
      const source = await storage.getSubmission(submissionId);
      expect(source).toMatchObject({ status: "queued", run_id: replayId, prompt: submissionId === "baseline" ? "" : `prompt-${submissionId}` });
      expect(source?.run_ids).toEqual([oldId, replayId]);
      const events = await storage.listRunEvents(replayId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "run.created", payload: { submission_id: submissionId, replay_of_run_id: oldId, replay_operation_id: OPERATION_ID } });
    }
  });

  it("stamps an unstamped competition only after every replay pointer is committed", async () => {
    const storage = await seededStorage();
    await storage.putCompetition(competition({ pricing_version: undefined }));

    await replayCompetition(storage, options());
    expect((await storage.getCompetition(COMPETITION_ID))?.pricing_version).toBeUndefined();

    await replayCompetition(storage, options(true));
    expect((await storage.getCompetition(COMPETITION_ID))?.pricing_version).toBe(PRICING_VERSION);
  });

  it.each(invalidReplayCases)("refuses %s before creating any replay run", async (_label, change) => {
    const storage = await seededStorage();
    if (change.competition) await storage.putCompetition(competition(change.competition));
    if (change.run) await storage.putRun(completedRun("old-a", "a", change.run));
    if (change.submission) await storage.putSubmission(submission("a", "old-a", change.submission));

    await expect(replayCompetition(storage, { ...options(true), expectedCount: change.expectedCount ?? 3 })).rejects.toThrow();
    expect((await storage.listRuns()).filter((run) => run.id.startsWith("replay-")).length).toBe(0);
  });

  it("requires a UUID operation id and rejects another operation while this replay remains active", async () => {
    const storage = await seededStorage();
    await expect(replayCompetition(storage, { ...options(), operationId: "not-a-uuid" })).rejects.toThrow(/operation/i);

    await replayCompetition(storage, options(true));
    await expect(replayCompetition(storage, { ...options(true), operationId: "681c3c2d-befc-4698-bd47-007ab04fdd90" })).rejects.toThrow(/active|operation/i);
  });

  it("is idempotent for the same operation and repairs a submission pointer after a partial write", async () => {
    const storage = await seededStorage();
    let failOnce = true;
    const flaky = new Proxy(storage, {
      get(target, property) {
        if (property === "putSubmission") {
          return async (value: Submission) => {
            if (value.id === "a" && value.run_id === "replay-a" && failOnce) {
              failOnce = false;
              throw new Error("simulated submission write failure");
            }
            return target.putSubmission(value);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Storage;

    await expect(replayCompetition(flaky, options(true))).rejects.toThrow("simulated submission write failure");
    expect((await storage.getCompetition(COMPETITION_ID))?.pricing_version).toBe(PRICING_VERSION);
    const partialRuns = (await storage.listRuns()).filter((run) => run.id.startsWith("replay-"));
    expect(partialRuns).toHaveLength(2);
    expect(partialRuns.every((run) => run.replay_ready === false)).toBe(true);

    const repaired = await replayCompetition(storage, options(true));
    expect(repaired).toMatchObject({ operationId: OPERATION_ID });
    expect((await storage.listRuns()).filter((run) => run.id.startsWith("replay-")).length).toBe(3);
    expect((await storage.listRuns()).filter((run) => run.id.startsWith("replay-")).every((run) => run.replay_ready === true)).toBe(true);
    expect((await storage.getSubmission("a"))?.run_id).toBe("replay-a");
    expect((await storage.getSubmission("a"))?.run_ids).toEqual(["old-a", "replay-a"]);
  });

  it("does not stamp an unstamped competition until every replay pointer is reconciled", async () => {
    const storage = await seededStorage();
    await storage.putCompetition(competition({ pricing_version: undefined }));
    const failing = new Proxy(storage, {
      get(target, property) {
        if (property === "putSubmission") return async () => { throw new Error("pointer write failed"); };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Storage;

    await expect(replayCompetition(failing, options(true))).rejects.toThrow("pointer write failed");
    expect((await storage.getCompetition(COMPETITION_ID))?.pricing_version).toBeUndefined();
  });

  it("reuses a deterministic create-only reservation even when listRuns is stale", async () => {
    const storage = await seededStorage();
    const staleList = (await storage.listRuns()).filter((run) => !run.replay_operation_id);
    const adapter = new Proxy(storage, {
      get(target, property) {
        if (property === "listRuns") return async () => staleList;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Storage;

    const first = await replayCompetition(adapter, options(true));
    const second = await replayCompetition(adapter, options(true));
    expect(second.runIds).toEqual(first.runIds);
    expect((await storage.listRuns()).filter((run) => run.replay_operation_id === OPERATION_ID)).toHaveLength(3);
  });

  it("rejects a different operation through the durable competition lock even when run listings are stale", async () => {
    const storage = await seededStorage();
    const originalSubmissions = await storage.listSubmissions();
    const oldRuns = await storage.listRuns();
    await replayCompetition(storage, options(true));
    for (const source of originalSubmissions) await storage.putSubmission(source);
    const stale = new Proxy(storage, {
      get(target, property) {
        if (property === "listRuns") return async () => oldRuns;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Storage;

    const differentOperation = { ...options(true), uuid: undefined };
    await expect(replayCompetition(stale, {
      ...differentOperation,
      operationId: "681c3c2d-befc-4698-bd47-007ab04fdd90",
    })).rejects.toThrow(/operation|reserved|conflict/i);
  });

  it("does not resurrect a terminal failed replay on an idempotent retry", async () => {
    const storage = await seededStorage();
    await replayCompetition(storage, options(true));
    await storage.putRun(completedRun("replay-a", "a", {
      status: "reaped",
      replay_of_run_id: "old-a",
      replay_operation_id: OPERATION_ID,
    } as Partial<Run>));

    await replayCompetition(storage, options(true));
    expect((await storage.getSubmission("a"))?.status).toBe("failed");
    expect((await storage.getSubmission("a"))?.run_id).toBe("replay-a");
  });
});
