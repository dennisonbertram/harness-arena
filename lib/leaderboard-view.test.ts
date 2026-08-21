import { describe, expect, it } from "vitest";
import {
  getLeaderboardSections,
  getLeaderboardView,
  getStandings,
  partitionBaseline,
  type LeaderboardRow,
} from "./leaderboard-view";
import { MemoryStorage } from "./storage";
import { getTasks } from "./tasks";
import type { Run, Submission, TaskResult } from "./types";

const TASK_COUNT = getTasks().length;

// A result set that completes the whole test (every task passed) — the only
// kind of run that gets ranked. `failOne` drops the last task to a fail, i.e.
// an incomplete run.
function fullResults(failOne = false): TaskResult[] {
  return getTasks().map((task, i) => ({
    task_id: task.id,
    attempted: true,
    passed: !(failOne && i === TASK_COUNT - 1),
  }));
}

function row(over: Partial<LeaderboardRow>): LeaderboardRow {
  return {
    rank: 1,
    runId: "r",
    agentName: "a",
    tasksPassed: 0,
    totalTasks: 10,
    costPerTaskUsd: 0,
    totalCostUsd: 0,
    submittedAt: "2026-07-22T00:00:00.000Z",
    ...over,
  };
}

describe("partitionBaseline", () => {
  it("pulls the baseline out and re-ranks the remaining competitors 1..n", () => {
    const rows = [
      row({ runId: "c1", agentName: "plan", rank: 1 }),
      row({ runId: "base", agentName: "pi-vanilla-baseline", rank: 2 }),
      row({ runId: "c2", agentName: "terse", rank: 3 }),
    ];
    const { baseline, competitors } = partitionBaseline(rows);
    expect(baseline?.runId).toBe("base");
    expect(competitors.map((c) => [c.runId, c.rank])).toEqual([
      ["c1", 1],
      ["c2", 2],
    ]);
  });

  it("returns a null baseline (and all rows as competitors) when none is present", () => {
    const rows = [row({ runId: "c1", agentName: "plan" })];
    const { baseline, competitors } = partitionBaseline(rows);
    expect(baseline).toBeNull();
    expect(competitors).toHaveLength(1);
  });
});

function submission(id: string, agentName: string, createdAt: string, overrides: Partial<Submission> = {}): Submission {
  return {
    id,
    agent_name: agentName,
    prompt: "do the thing",
    status: "scored",
    created_at: createdAt,
    ...overrides,
  };
}

function run(id: string, submissionId: string, status: Run["status"], overrides: Partial<Run> = {}): Run {
  return {
    id,
    submission_id: submissionId,
    status,
    task_results: [],
    created_at: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("getLeaderboardView", () => {
  it("returns an empty array when there are no runs", async () => {
    const storage = new MemoryStorage();

    const rows = await getLeaderboardView(storage);

    expect(rows).toEqual([]);
  });

  it("joins a complete-test run with its submission's agent name and rank", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(submission("sub-1", "agent-x", "2026-07-19T00:00:00.000Z"));
    await storage.putRun(
      run("run-1", "sub-1", "completed", {
        tasks_passed: TASK_COUNT,
        total_cost_usd: 2.0,
        task_results: fullResults(),
      }),
    );

    const rows = await getLeaderboardView(storage);

    expect(rows).toEqual([
      {
        rank: 1,
        runId: "run-1",
        agentName: "agent-x",
        tasksPassed: TASK_COUNT,
        totalTasks: TASK_COUNT,
        costPerTaskUsd: 2.0 / TASK_COUNT,
        totalCostUsd: 2.0,
        submittedAt: "2026-07-19T00:00:00.000Z",
      },
    ]);
  });

  it("ranks multiple complete-test runs by cost ascending", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(submission("sub-1", "agent-a", "2026-07-19T00:00:00.000Z"));
    await storage.putSubmission(submission("sub-2", "agent-b", "2026-07-18T00:00:00.000Z"));
    await storage.putRun(
      run("run-1", "sub-1", "completed", { tasks_passed: TASK_COUNT, total_cost_usd: 3.0, task_results: fullResults() }),
    );
    await storage.putRun(
      run("run-2", "sub-2", "completed", { tasks_passed: TASK_COUNT, total_cost_usd: 1.0, task_results: fullResults() }),
    );

    const rows = await getLeaderboardView(storage);

    expect(rows.map((r) => ({ rank: r.rank, agentName: r.agentName }))).toEqual([
      { rank: 1, agentName: "agent-b" },
      { rank: 2, agentName: "agent-a" },
    ]);
  });

  it("excludes runs that didn't complete the whole test (ranked is empty, incomplete holds them)", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(submission("sub-1", "agent-a", "2026-07-19T00:00:00.000Z"));
    await storage.putRun(
      run("run-1", "sub-1", "completed", {
        tasks_passed: TASK_COUNT - 1,
        total_cost_usd: 0.1,
        task_results: fullResults(true),
      }),
    );

    const { ranked, incomplete } = await getLeaderboardSections(storage);

    expect(ranked).toEqual([]);
    expect(incomplete.map((r) => r.runId)).toEqual(["run-1"]);
  });

  it("excludes runs that are not completed", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(submission("sub-1", "agent-a", "2026-07-19T00:00:00.000Z"));
    await storage.putRun(run("run-1", "sub-1", "running"));

    const rows = await getLeaderboardView(storage);

    expect(rows).toEqual([]);
  });

  describe("regression: a run referencing a missing submission must not crash the join", () => {
    it("falls back to a placeholder agent name instead of throwing", async () => {
      const storage = new MemoryStorage();
      await storage.putRun(
        run("run-1", "sub-does-not-exist", "completed", {
          tasks_passed: TASK_COUNT,
          total_cost_usd: 0.5,
          task_results: fullResults(),
        }),
      );

      const rows = await getLeaderboardView(storage);

      expect(rows).toHaveLength(1);
      expect(rows[0].agentName).toBe("unknown");
    });
  });
});

// The two boards share one storage, so a swe-bench submission's runs must
// never surface on the default terminal-bench board (and vice versa) —
// otherwise a SWE patch run would be ranked against terminal-bench task
// counts it never attempted.
describe("board discrimination (benchmark field)", () => {
  it("keeps a swe-bench submission's runs off the default terminal-bench sections and vice versa", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(submission("sub-tb", "tb-agent", "2026-07-19T00:00:00.000Z"));
    await storage.putSubmission(
      submission("sub-swe", "swe-agent", "2026-07-19T00:00:00.000Z", { benchmark: "swe-bench" }),
    );
    await storage.putRun(
      run("run-tb", "sub-tb", "completed", {
        tasks_passed: TASK_COUNT,
        total_cost_usd: 2.0,
        task_results: fullResults(),
      }),
    );
    await storage.putRun(
      run("run-swe", "sub-swe", "completed", {
        tasks_passed: TASK_COUNT,
        total_cost_usd: 1.0,
        task_results: fullResults(),
      }),
    );

    const tb = await getLeaderboardSections(storage);
    expect(tb.ranked.map((r) => r.runId)).toEqual(["run-tb"]);
    expect(tb.incomplete.map((r) => r.runId)).toEqual([]);

    const swe = await getLeaderboardSections(storage, "swe-bench");
    expect(swe.ranked.map((r) => r.runId)).toEqual(["run-swe"]);
    expect(swe.incomplete.map((r) => r.runId)).toEqual([]);
  });

  it("treats an absent benchmark field as terminal-bench-2 (legacy rows stay on the default board)", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(submission("sub-legacy", "legacy-agent", "2026-07-19T00:00:00.000Z"));
    await storage.putRun(
      run("run-legacy", "sub-legacy", "completed", {
        tasks_passed: TASK_COUNT,
        total_cost_usd: 1.0,
        task_results: fullResults(),
      }),
    );

    const tb = await getLeaderboardSections(storage);
    expect(tb.ranked.map((r) => r.runId)).toEqual(["run-legacy"]);
    const swe = await getLeaderboardSections(storage, "swe-bench");
    expect(swe.ranked).toEqual([]);
  });

  it("keeps swe-bench standings out of the default getStandings view used by /api/leaderboard", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(submission("sub-tb", "tb-agent", "2026-07-19T00:00:00.000Z"));
    await storage.putSubmission(
      submission("sub-swe", "swe-agent", "2026-07-19T00:00:00.000Z", { benchmark: "swe-bench" }),
    );
    await storage.putRun(
      run("run-tb", "sub-tb", "completed", {
        tasks_passed: TASK_COUNT,
        total_cost_usd: 1.0,
        task_results: fullResults(),
      }),
    );
    await storage.putRun(
      run("run-swe", "sub-swe", "completed", {
        tasks_passed: TASK_COUNT,
        total_cost_usd: 0.5,
        task_results: fullResults(),
      }),
    );

    const standings = await getStandings(storage);
    expect(standings.map((s) => s.agentName)).toEqual(["tb-agent"]);
  });
});
