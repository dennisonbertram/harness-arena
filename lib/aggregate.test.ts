import { describe, expect, it } from "vitest";
import { aggregatePrompts, aggregateTask } from "./aggregate";
import type { Run, Submission, TaskResult } from "./types";

const TOTAL = 4; // 4-task test in these fixtures

// turns defaults to 1 (the task actually ran) so any provided cost counts as
// real spend; pass explicit turns to exercise the 0-turn/unmeasured path.
function results(passFlags: boolean[], costs?: number[], turns?: number[]): TaskResult[] {
  return passFlags.map((passed, i) => ({
    task_id: `t${i}`,
    attempted: true,
    passed,
    turns: turns ? turns[i] : 1,
    ...(costs ? { cost_usd: costs[i] } : {}),
  }));
}

function sub(id: string, agentName: string, prompt: string, createdAt: string): Submission {
  return { id, agent_name: agentName, prompt, status: "scored", created_at: createdAt };
}

function run(
  id: string,
  submissionId: string,
  passFlags: boolean[],
  costUsd?: number,
  status: Run["status"] = "completed",
  taskCosts?: number[],
  taskTurns?: number[],
): Run {
  return {
    id,
    submission_id: submissionId,
    status,
    tasks_passed: status === "completed" ? passFlags.filter(Boolean).length : undefined,
    total_cost_usd: costUsd,
    task_results: results(passFlags, taskCosts, taskTurns),
    created_at: "2026-07-21T00:00:00.000Z",
  };
}

describe("aggregatePrompts", () => {
  it("averages tasks passed across a prompt's runs into a mean pass rate", () => {
    const submissions = [sub("s1", "vanilla", "", "2026-07-20T00:00:00Z")];
    // same prompt, three runs: 4/4, 2/4, 3/4 -> mean 3/4 = 0.75
    const runs = [
      run("r1", "s1", [true, true, true, true], 1.0),
      run("r2", "s1", [true, true, false, false], 1.2),
      run("r3", "s1", [true, true, true, false], 0.8),
    ];
    const [st] = aggregatePrompts(runs, submissions, TOTAL);
    expect(st.runs).toBe(3);
    expect(st.meanTasksPassed).toBeCloseTo(3);
    expect(st.passRate).toBeCloseTo(0.75);
    expect(st.medianCostUsd).toBeCloseTo(1.0);
    expect(st.completesTest).toBe(false);
  });

  it("computes per-task cost (mean across runs) alongside the pass rate", () => {
    const submissions = [sub("s1", "vanilla", "", "2026-07-20T00:00:00Z")];
    const runs = [
      run("r1", "s1", [true, false, false, false], undefined, "completed", [0.02, 0.1, 0.2, 0.3]),
      run("r2", "s1", [true, false, false, false], undefined, "completed", [0.04, 0.2, 0.2, 0.3]),
    ];
    const [st] = aggregatePrompts(runs, submissions, TOTAL);
    const byId = Object.fromEntries(st.perTask.map((p) => [p.taskId, p.meanCostUsd]));
    expect(byId.t0).toBeCloseTo(0.03); // (0.02 + 0.04) / 2
    expect(byId.t1).toBeCloseTo(0.15); // (0.1 + 0.2) / 2 — a failing task still has a cost
  });

  it("reports null per-task cost when no cost was recorded", () => {
    const submissions = [sub("s1", "vanilla", "", "2026-07-20T00:00:00Z")];
    const runs = [run("r1", "s1", [true, false, false, false])]; // no taskCosts
    const [st] = aggregatePrompts(runs, submissions, TOTAL);
    expect(st.perTask[0].meanCostUsd).toBeNull();
  });

  it("treats a 0-turn task's stored cost as unmeasured (de-fabricates the old $0.05 floor)", () => {
    const submissions = [sub("s1", "vanilla", "", "2026-07-20T00:00:00Z")];
    // task t0 ran 5 turns and cost $0.02 (real); task t1 ran 0 turns but has a
    // stored $0.05 (the old fabricated floor) — that must NOT count as cost.
    const runs = [
      run("r1", "s1", [true, false, false, false], undefined, "completed", [0.02, 0.05, 0, 0], [5, 0, 0, 0]),
    ];
    const [st] = aggregatePrompts(runs, submissions, TOTAL);
    const byId = Object.fromEntries(st.perTask.map((p) => [p.taskId, p.meanCostUsd]));
    expect(byId.t0).toBeCloseTo(0.02); // real spend, counted
    expect(byId.t1).toBeNull(); // 0 turns -> stored $0.05 is not a real measurement
  });

  it("reports mean turns per task (0 = the agent never engaged the task)", () => {
    const submissions = [sub("s1", "vanilla", "", "2026-07-20T00:00:00Z")];
    const runs = [
      run("r1", "s1", [true, false, false, false], undefined, "completed", undefined, [10, 0, 4, 2]),
      run("r2", "s1", [true, false, false, false], undefined, "completed", undefined, [20, 0, 4, 2]),
    ];
    const [st] = aggregatePrompts(runs, submissions, TOTAL);
    const turns = Object.fromEntries(st.perTask.map((p) => [p.taskId, p.meanTurns]));
    expect(turns.t0).toBeCloseTo(15); // (10+20)/2
    expect(turns.t1).toBe(0); // never engaged in either run
  });

  it("computes per-task pass rate across runs", () => {
    const submissions = [sub("s1", "vanilla", "", "2026-07-20T00:00:00Z")];
    const runs = [
      run("r1", "s1", [true, true, false, false]),
      run("r2", "s1", [true, false, false, false]),
    ];
    const [st] = aggregatePrompts(runs, submissions, TOTAL);
    const byId = Object.fromEntries(st.perTask.map((p) => [p.taskId, `${p.passed}/${p.of}`]));
    expect(byId).toEqual({ t0: "2/2", t1: "1/2", t2: "0/2", t3: "0/2" });
    // sorted by rate desc: t0 (100%) first, the two 0% last
    expect(st.perTask[0].taskId).toBe("t0");
  });

  it("groups runs by prompt, not by submission — resubmitting the same prompt adds samples", () => {
    const submissions = [
      sub("s1", "alice", "SAME PROMPT", "2026-07-20T00:00:00Z"),
      sub("s2", "bob", "SAME PROMPT", "2026-07-21T00:00:00Z"), // newer -> representative name
      sub("s3", "carol", "DIFFERENT", "2026-07-20T00:00:00Z"),
    ];
    const runs = [
      run("r1", "s1", [true, true, false, false]),
      run("r2", "s2", [true, true, true, false]),
      run("r3", "s3", [true, false, false, false]),
    ];
    const standings = aggregatePrompts(runs, submissions, TOTAL);
    const same = standings.find((s) => s.promptKey === "SAME PROMPT")!;
    expect(same.runs).toBe(2);
    expect(same.agentName).toBe("bob"); // most recent submission of that prompt
    expect(standings.find((s) => s.promptKey === "DIFFERENT")!.runs).toBe(1);
  });

  it("ranks by pass rate descending, cheaper median cost breaking ties", () => {
    const submissions = [
      sub("s1", "high", "P1", "2026-07-20T00:00:00Z"),
      sub("s2", "tie-cheap", "P2", "2026-07-20T00:00:00Z"),
      sub("s3", "tie-dear", "P3", "2026-07-20T00:00:00Z"),
    ];
    const runs = [
      run("r1", "s1", [true, true, true, false], 5.0), // 0.75 rate, expensive
      run("r2", "s2", [true, true, false, false], 1.0), // 0.5 rate, cheap
      run("r3", "s3", [true, true, false, false], 2.0), // 0.5 rate, dearer
    ];
    const order = aggregatePrompts(runs, submissions, TOTAL).map((s) => s.agentName);
    expect(order).toEqual(["high", "tie-cheap", "tie-dear"]);
  });

  it("ignores non-completed runs (not valid samples)", () => {
    const submissions = [sub("s1", "vanilla", "", "2026-07-20T00:00:00Z")];
    const runs = [
      run("r1", "s1", [true, true, true, true], 1.0, "completed"),
      run("r2", "s1", [true, false, false, false], undefined, "running"),
      run("r3", "s1", [false, false, false, false], undefined, "failed"),
    ];
    const [st] = aggregatePrompts(runs, submissions, TOTAL);
    expect(st.runs).toBe(1);
    expect(st.passRate).toBe(1);
    expect(st.completesTest).toBe(true);
  });
});

describe("aggregateTask", () => {
  const subs = [
    sub("s1", "alice", "P1", "2026-07-20T00:00:00Z"),
    sub("s2", "bob", "P2", "2026-07-21T00:00:00Z"),
  ];

  it("collects every completed run's result for one task, honest cost, newest first", () => {
    const runs = [
      // t0: alice passed (5 turns, $0.02); bob failed but ran 0 turns -> unmeasured cost.
      run("r1", "s1", [true, false, false, false], undefined, "completed", [0.02, 0, 0, 0], [5, 0, 0, 0]),
      run("r2", "s2", [false, false, false, false], undefined, "completed", [0.05, 0, 0, 0], [0, 0, 0, 0]),
    ];
    const stats = aggregateTask(runs, subs, "t0")!;
    expect(stats.attempts).toBe(2);
    expect(stats.passed).toBe(1);
    expect(stats.passRate).toBeCloseTo(0.5);
    expect(stats.meanTurns).toBeCloseTo(2.5); // (5 + 0) / 2
    expect(stats.meanCostUsd).toBeCloseTo(0.02); // only the 5-turn run counts; 0-turn is unmeasured
    // newest submission (bob, s2 2026-07-21) first
    expect(stats.results.map((r) => r.agentName)).toEqual(["bob", "alice"]);
    expect(stats.results.find((r) => r.agentName === "bob")!.costUsd).toBeNull();
  });

  it("returns null when no completed run recorded the task", () => {
    const runs = [run("r1", "s1", [true, false, false, false], undefined, "running")];
    expect(aggregateTask(runs, subs, "t0")).toBeNull();
  });
});
