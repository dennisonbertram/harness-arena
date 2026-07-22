import { describe, expect, it } from "vitest";
import { getLeaderboardView } from "./leaderboard-view";
import { MemoryStorage } from "./storage";
import type { Run, Submission } from "./types";

function submission(id: string, agentName: string, createdAt: string): Submission {
  return {
    id,
    agent_name: agentName,
    prompt: "do the thing",
    status: "scored",
    created_at: createdAt,
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

  it("joins a completed run with its submission's agent name and rank", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(submission("sub-1", "agent-x", "2026-07-19T00:00:00.000Z"));
    await storage.putRun(
      run("run-1", "sub-1", "completed", {
        tasks_passed: 8,
        total_cost_usd: 2.0,
        task_results: new Array(10).fill(0).map((_, i) => ({
          task_id: `t${i}`,
          attempted: true,
          passed: i < 8,
        })),
      }),
    );

    const rows = await getLeaderboardView(storage);

    expect(rows).toEqual([
      {
        rank: 1,
        runId: "run-1",
        agentName: "agent-x",
        tasksPassed: 8,
        totalTasks: 10,
        costPerTaskUsd: 0.2,
        totalCostUsd: 2.0,
        submittedAt: "2026-07-19T00:00:00.000Z",
      },
    ]);
  });

  it("ranks multiple completed runs using the same order as sortLeaderboard", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(submission("sub-1", "agent-a", "2026-07-19T00:00:00.000Z"));
    await storage.putSubmission(submission("sub-2", "agent-b", "2026-07-18T00:00:00.000Z"));
    await storage.putRun(run("run-1", "sub-1", "completed", { tasks_passed: 5, total_cost_usd: 3.0 }));
    await storage.putRun(run("run-2", "sub-2", "completed", { tasks_passed: 7, total_cost_usd: 1.0 }));

    const rows = await getLeaderboardView(storage);

    expect(rows.map((r) => ({ rank: r.rank, agentName: r.agentName }))).toEqual([
      { rank: 1, agentName: "agent-b" },
      { rank: 2, agentName: "agent-a" },
    ]);
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
        run("run-1", "sub-does-not-exist", "completed", { tasks_passed: 2, total_cost_usd: 0.5 }),
      );

      const rows = await getLeaderboardView(storage);

      expect(rows).toHaveLength(1);
      expect(rows[0].agentName).toBe("unknown");
    });
  });
});
