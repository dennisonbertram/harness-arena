import { describe, expect, it } from "vitest";
import { CompetitionSchema, RunEventSchema, RunSchema, SubmissionSchema } from "./types";

describe("RunSchema timestamp validation", () => {
  it("rejects created_at that is not a valid ISO datetime string", () => {
    const result = RunSchema.safeParse({
      id: "run-1",
      submission_id: "sub-1",
      status: "queued",
      task_results: [],
      created_at: "not-a-date",
    });

    expect(result.success).toBe(false);
  });

  it("accepts a valid ISO datetime string for created_at", () => {
    const result = RunSchema.safeParse({
      id: "run-1",
      submission_id: "sub-1",
      status: "queued",
      task_results: [],
      created_at: "2026-07-21T00:00:00.000Z",
    });

    expect(result.success).toBe(true);
  });
});

describe("RUN_EVENT_TYPES: task.cost_tamper_signal (runner-emitted, issue #24)", () => {
  it("accepts a task.cost_tamper_signal event as a valid RunEvent", () => {
    const result = RunEventSchema.safeParse({
      run_id: "run-1",
      seq: 1,
      ts: "2026-07-21T00:00:00.000Z",
      type: "task.cost_tamper_signal",
      payload: { task_id: "t1", reason: "cost_unmeasured" },
    });

    expect(result.success).toBe(true);
  });
});

describe("CompetitionSchema (issue #75)", () => {
  it("round-trips a seeded competition with prize fields unset (null, not a placeholder)", () => {
    const competition = {
      id: "comp-1",
      arena: "harness-arena",
      harness: "pi",
      model: "zai/glm-5.2",
      prize_amount_usd: null,
      prize_cadence: null,
      status: "live" as const,
      created_at: "2026-07-27T00:00:00.000Z",
    };

    const result = CompetitionSchema.safeParse(competition);

    expect(result.success).toBe(true);
    expect(result.data?.prize_amount_usd).toBeNull();
    expect(result.data?.prize_cadence).toBeNull();
  });

  it("accepts any arena string -- not a closed enum, since other arena types are coming", () => {
    const result = CompetitionSchema.safeParse({
      id: "comp-2",
      arena: "some-future-bounty-arena",
      harness: "pi",
      model: "zai/glm-5.2",
      status: "closed",
      created_at: "2026-07-27T00:00:00.000Z",
      closed_at: "2026-07-28T00:00:00.000Z",
    });

    expect(result.success).toBe(true);
  });

  it("rejects a prize_cadence outside daily/weekly/monthly/one-time", () => {
    const result = CompetitionSchema.safeParse({
      id: "comp-3",
      arena: "harness-arena",
      harness: "pi",
      model: "zai/glm-5.2",
      prize_cadence: "yearly",
      status: "live",
      created_at: "2026-07-27T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });
});

describe("SubmissionSchema: competition_id alongside legacy competition boolean (issue #75)", () => {
  it("parses a LEGACY submission that has competition:true and no competition_id", () => {
    const result = SubmissionSchema.safeParse({
      id: "sub-legacy",
      agent_name: "agent-x",
      prompt: "do the thing",
      status: "scored",
      competition: true,
      created_at: "2026-07-01T00:00:00.000Z",
    });

    expect(result.success).toBe(true);
    expect(result.data?.competition).toBe(true);
    expect(result.data?.competition_id).toBeUndefined();
  });

  it("round-trips a post-backfill submission carrying both competition and competition_id", () => {
    const result = SubmissionSchema.safeParse({
      id: "sub-new",
      agent_name: "agent-y",
      prompt: "do the thing",
      status: "scored",
      competition: true,
      competition_id: "comp-1",
      created_at: "2026-07-27T00:00:00.000Z",
    });

    expect(result.success).toBe(true);
    expect(result.data?.competition_id).toBe("comp-1");
  });
});
