import { describe, expect, it } from "vitest";
import {
  countByStatus,
  PER_RUN_BUDGET_CAP_USD,
  POC_BUDGET_CAP_USD,
  recentActivity,
  totalSpendUsd,
} from "./status-view";
import { RUN_STATUSES, SUBMISSION_STATUSES } from "./types";
import type { Run, RunEvent, Submission } from "./types";

function submission(id: string, agentName: string, overrides: Partial<Submission> = {}): Submission {
  return {
    id,
    agent_name: agentName,
    prompt: "do the thing",
    status: "scored",
    created_at: "2026-07-19T00:00:00.000Z",
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

function event(runId: string, seq: number, type: RunEvent["type"], ts: string): RunEvent {
  return { run_id: runId, seq, ts, type, payload: {} };
}

describe("countByStatus", () => {
  it("counts runs per status, including zero for statuses with no runs", () => {
    const runs = [
      run("r1", "s1", "completed"),
      run("r2", "s1", "completed"),
      run("r3", "s1", "failed"),
      run("r4", "s1", "queued"),
    ];

    const counts = countByStatus(runs, RUN_STATUSES);

    expect(counts).toEqual({
      queued: 1,
      running: 0,
      completed: 2,
      failed: 1,
      reaped: 0,
    });
  });

  it("counts submissions per status, including zero for statuses with no submissions", () => {
    const submissions = [
      submission("s1", "agent-a", { status: "pending_review" }),
      submission("s2", "agent-b", { status: "scored" }),
      submission("s3", "agent-c", { status: "scored" }),
    ];

    const counts = countByStatus(submissions, SUBMISSION_STATUSES);

    expect(counts).toEqual({
      pending_review: 1,
      rejected: 0,
      queued: 0,
      running: 0,
      scored: 2,
      failed: 0,
    });
  });

  it("returns all-zero counts when there are no items", () => {
    const counts = countByStatus([], RUN_STATUSES);

    expect(counts).toEqual({
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      reaped: 0,
    });
  });
});

describe("recentActivity", () => {
  it("joins each run with its submitting agent's name and its most recent event", () => {
    const runs = [
      run("r1", "s1", "completed", { tasks_passed: 8, total_cost_usd: 1.5 }),
    ];
    const submissions = [submission("s1", "agent-x")];
    const eventsByRun = new Map<string, RunEvent[]>([
      [
        "r1",
        [
          event("r1", 1, "run.created", "2026-07-20T00:00:00.000Z"),
          event("r1", 3, "run.completed", "2026-07-20T00:05:00.000Z"),
          event("r1", 2, "task.started", "2026-07-20T00:02:00.000Z"),
        ],
      ],
    ]);

    const rows = recentActivity(runs, submissions, eventsByRun);

    expect(rows).toEqual([
      {
        runId: "r1",
        agentName: "agent-x",
        githubLogin: "unknown",
        status: "completed",
        tasksPassed: 8,
        totalTasks: 0,
        totalCostUsd: 1.5,
        lastEventType: "run.completed",
        lastEventAt: "2026-07-20T00:05:00.000Z",
      },
    ]);
  });

  it("carries the submitting agent's github_login, falling back to 'unknown' when unset", () => {
    const runs = [run("r1", "s1", "completed")];
    const submissions = [submission("s1", "agent-x", { github_login: "octocat" })];

    const rows = recentActivity(runs, submissions, new Map());

    expect(rows[0].githubLogin).toBe("octocat");
  });

  it("preserves the given run order (assumed newest-first) and limits to the given limit", () => {
    const runs = [
      run("r1", "s1", "completed", { created_at: "2026-07-20T02:00:00.000Z" }),
      run("r2", "s1", "completed", { created_at: "2026-07-20T01:00:00.000Z" }),
      run("r3", "s1", "completed", { created_at: "2026-07-20T00:00:00.000Z" }),
    ];
    const submissions = [submission("s1", "agent-x")];

    const rows = recentActivity(runs, submissions, new Map(), 2);

    expect(rows.map((r) => r.runId)).toEqual(["r1", "r2"]);
  });

  it("falls back to 'unknown' when a run references a submission that no longer exists", () => {
    const runs = [run("r1", "sub-missing", "failed")];

    const rows = recentActivity(runs, [], new Map());

    expect(rows[0].agentName).toBe("unknown");
  });

  it("reports undefined last-event fields when a run has no events yet", () => {
    const runs = [run("r1", "s1", "queued")];
    const submissions = [submission("s1", "agent-x")];

    const rows = recentActivity(runs, submissions, new Map());

    expect(rows[0].lastEventType).toBeUndefined();
    expect(rows[0].lastEventAt).toBeUndefined();
  });
});

describe("totalSpendUsd", () => {
  it("sums total_cost_usd across all runs that have a recorded cost", () => {
    const runs = [
      run("r1", "s1", "completed", { total_cost_usd: 1.25 }),
      run("r2", "s1", "failed", { total_cost_usd: 0.5 }),
      run("r3", "s1", "queued"),
    ];

    expect(totalSpendUsd(runs)).toBe(1.75);
  });

  it("returns 0 when there are no runs", () => {
    expect(totalSpendUsd([])).toBe(0);
  });
});

describe("regression", () => {
  it("countByStatus never drops or double-counts an item — every item's status is counted exactly once", () => {
    // Walks the authoritative RUN_STATUSES list from lib/types.ts rather
    // than a hardcoded set, so counts always sum back to the input length
    // no matter how the status list grows in the future.
    const runs = RUN_STATUSES.flatMap((status, i) =>
      new Array(i + 1).fill(0).map((_, j) => run(`${status}-${j}`, "s1", status)),
    );

    const counts = countByStatus(runs, RUN_STATUSES);

    const totalCounted = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(totalCounted).toBe(runs.length);
  });

  it("recentActivity keeps each run's last-event lookup isolated — one run's events never leak into another run's row", () => {
    const runs = [run("r1", "s1", "running"), run("r2", "s1", "completed")];
    const submissions = [submission("s1", "agent-x")];
    const eventsByRun = new Map<string, RunEvent[]>([
      ["r1", [event("r1", 1, "run.created", "2026-07-20T00:00:00.000Z")]],
      ["r2", [event("r2", 1, "run.created", "2026-07-19T00:00:00.000Z"), event("r2", 2, "run.completed", "2026-07-19T00:05:00.000Z")]],
    ]);

    const rows = recentActivity(runs, submissions, eventsByRun);

    expect(rows.find((r) => r.runId === "r1")?.lastEventType).toBe("run.created");
    expect(rows.find((r) => r.runId === "r2")?.lastEventType).toBe("run.completed");
  });

  it("keeps the POC budget figures at $25 total / $2 per-run — the same figures ticket #8's proof-run budget uses, not a separately drifted number", () => {
    expect(POC_BUDGET_CAP_USD).toBe(25);
    expect(PER_RUN_BUDGET_CAP_USD).toBe(2);
  });
});
