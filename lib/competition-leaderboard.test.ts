import { describe, expect, it } from "vitest";
import { getCompetitionBoard, rankCompetition, type CompetitionRow } from "./competition-leaderboard";
import { MemoryStorage } from "./storage";
import type { Run, Submission } from "./types";

function row(tasksPassed: number, totalCostUsd: number, overrides: Partial<CompetitionRow> = {}): CompetitionRow {
  return {
    submissionId: overrides.submissionId ?? `s-${tasksPassed}-${totalCostUsd}`,
    runId: overrides.runId ?? `r-${tasksPassed}-${totalCostUsd}`,
    rank: 0,
    tied: false,
    tasksPassed,
    totalTasks: 16,
    totalCostUsd,
    submittedAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("rankCompetition", () => {
  it("ranks by tasks solved descending", () => {
    const ranked = rankCompetition([row(10, 1.0), row(14, 1.0)]);
    expect(ranked.map((r) => r.tasksPassed)).toEqual([14, 10]);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].rank).toBe(2);
  });

  it("breaks a tasks-solved tie by cost ascending", () => {
    const ranked = rankCompetition([row(10, 2.0), row(10, 1.0)]);
    expect(ranked.map((r) => r.totalCostUsd)).toEqual([1.0, 2.0]);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].rank).toBe(2);
  });

  it("marks an identical (tasksPassed, totalCostUsd) pair as tied at the same rank", () => {
    const ranked = rankCompetition([row(10, 1.0, { submissionId: "a" }), row(10, 1.0, { submissionId: "b" })]);
    expect(ranked.every((r) => r.rank === 1)).toBe(true);
    expect(ranked.every((r) => r.tied)).toBe(true);
  });

  it("a three-way tie shares rank 1; the next distinct entry ranks 4, not 2", () => {
    const ranked = rankCompetition([
      row(10, 1.0, { submissionId: "a" }),
      row(10, 1.0, { submissionId: "b" }),
      row(10, 1.0, { submissionId: "c" }),
      row(8, 5.0, { submissionId: "d" }),
    ]);
    expect(ranked.filter((r) => r.rank === 1)).toHaveLength(3);
    expect(ranked.find((r) => r.submissionId === "d")!.rank).toBe(4);
    expect(ranked.find((r) => r.submissionId === "d")!.tied).toBe(false);
  });
});

function sub(id: string, overrides: Partial<Submission> = {}): Submission {
  return {
    id,
    agent_name: "entrant",
    prompt: `prompt-${id}`,
    status: "scored",
    competition: true,
    created_at: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    submission_id: overrides.submission_id ?? "unset",
    status: "completed",
    task_results: [],
    created_at: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("getCompetitionBoard", () => {
  it("ranks completed competition runs and reports a pending count for queued/running ones", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("s1", { run_id: "r1" }));
    await storage.putRun(run("r1", { submission_id: "s1", tasks_passed: 14, total_cost_usd: 1.0, task_results: Array(16).fill({ task_id: "t", attempted: true, passed: true }) }));
    await storage.putSubmission(sub("s2", { run_id: "r2" }));
    await storage.putRun(run("r2", { submission_id: "s2", status: "queued", task_results: [] }));

    const board = await getCompetitionBoard(storage);
    expect(board.ranked).toHaveLength(1);
    expect(board.ranked[0].submissionId).toBe("s1");
    expect(board.pending).toBe(1);
  });

  it("excludes a non-competition submission entirely, even with a great score", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("s1", { run_id: "r1", competition: false }));
    await storage.putRun(run("r1", { submission_id: "s1", tasks_passed: 16, total_cost_usd: 0.5 }));

    const board = await getCompetitionBoard(storage);
    expect(board.ranked).toHaveLength(0);
  });

  it("reports baselineState 'none' when no baseline submission exists", async () => {
    const storage = new MemoryStorage();
    const board = await getCompetitionBoard(storage);
    expect(board.baselineState).toBe("none");
    expect(board.baseline).toBeNull();
  });

  it("reports baselineState 'running' when the baseline's run hasn't completed", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("base", { run_id: "rb", competition_baseline: true }));
    await storage.putRun(run("rb", { submission_id: "base", status: "queued", task_results: [] }));

    const board = await getCompetitionBoard(storage);
    expect(board.baselineState).toBe("running");
    expect(board.baseline).toBeNull();
  });

  it("reports baselineState 'rejected' with the judge's reason when the baseline was rejected", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("base", { competition_baseline: true, status: "rejected", judge_reason: "flagged" }));

    const board = await getCompetitionBoard(storage);
    expect(board.baselineState).toBe("rejected");
    expect(board.baselineRejectionReason).toBe("flagged");
  });

  it("reports baselineState 'ready' and populates baseline once its run completes", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("base", { run_id: "rb", competition_baseline: true }));
    await storage.putRun(run("rb", { submission_id: "base", tasks_passed: 6, total_cost_usd: 0.9, task_results: Array(16).fill({ task_id: "t", attempted: true, passed: false }) }));

    const board = await getCompetitionBoard(storage);
    expect(board.baselineState).toBe("ready");
    expect(board.baseline?.tasksPassed).toBe(6);
  });

  it("does not count the baseline submission among the ranked competitor rows", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("base", { run_id: "rb", competition_baseline: true }));
    await storage.putRun(run("rb", { submission_id: "base", tasks_passed: 6, total_cost_usd: 0.9, task_results: Array(16).fill({ task_id: "t", attempted: true, passed: false }) }));

    const board = await getCompetitionBoard(storage);
    expect(board.ranked).toHaveLength(0);
  });

  it("no completed competition runs yet -> ranked is empty", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("s1", { run_id: "r1" }));
    await storage.putRun(run("r1", { submission_id: "s1", status: "running", task_results: [] }));

    const board = await getCompetitionBoard(storage);
    expect(board.ranked).toEqual([]);
  });
});
