import { describe, expect, it } from "vitest";
import { aggregateAllRunsByTask, aggregatePrompts, aggregateTask, baselineDisplayName } from "./aggregate";
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

  it("groups by (prompt, model): the same prompt on different models is separate standings", () => {
    const submissions = [
      sub("s1", "glm", "SAME", "2026-07-20T00:00:00Z"),
      sub("s2", "sonnet", "SAME", "2026-07-21T00:00:00Z"),
    ];
    const glmRun = { ...run("r1", "s1", [true, true, false, false]), model: "zai/glm-5.2" };
    const sonnetRun = { ...run("r2", "s2", [true, true, true, false]), model: "anthropic/claude-sonnet-5" };
    const standings = aggregatePrompts([glmRun, sonnetRun], submissions, TOTAL);
    expect(standings).toHaveLength(2);
    const byModel = Object.fromEntries(standings.map((s) => [s.model, s.meanTasksPassed]));
    expect(byModel["zai/glm-5.2"]).toBe(2);
    expect(byModel["anthropic/claude-sonnet-5"]).toBe(3);
  });

  it("defaults a run with no model to glm-5.2", () => {
    const submissions = [sub("s1", "legacy", "P", "2026-07-20T00:00:00Z")];
    const [st] = aggregatePrompts([run("r1", "s1", [true, false, false, false])], submissions, TOTAL);
    expect(st.model).toBe("zai/glm-5.2");
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

  it("excludes competition submissions from the main-arena standings entirely", () => {
    const submissions = [
      sub("s1", "arena-entrant", "ARENA PROMPT", "2026-07-20T00:00:00Z"),
      { ...sub("s2", "comp-entrant", "ARENA PROMPT", "2026-07-21T00:00:00Z"), competition: true },
    ];
    const runs = [run("r1", "s1", [true, true, false, false]), run("r2", "s2", [true, true, true, true])];
    const standings = aggregatePrompts(runs, submissions, TOTAL);
    // Only the main-arena run counts, even though the competition submission
    // shares the identical (model, prompt) key and would otherwise average in.
    expect(standings).toHaveLength(1);
    expect(standings[0].runs).toBe(1);
    expect(standings[0].agentName).toBe("arena-entrant");
  });

  it("excludes competition submissions from BOTH competitions, not just one (issue #76)", () => {
    const submissions = [
      sub("s1", "arena-entrant", "ARENA PROMPT", "2026-07-20T00:00:00Z"),
      { ...sub("s2", "comp-a-entrant", "ARENA PROMPT", "2026-07-21T00:00:00Z"), competition: true, competition_id: "comp-a" },
      { ...sub("s3", "comp-b-entrant", "ARENA PROMPT", "2026-07-22T00:00:00Z"), competition: true, competition_id: "comp-b" },
    ];
    const runs = [
      run("r1", "s1", [true, true, false, false]),
      run("r2", "s2", [true, true, true, true]),
      run("r3", "s3", [true, true, true, true]),
    ];
    const standings = aggregatePrompts(runs, submissions, TOTAL);
    expect(standings).toHaveLength(1);
    expect(standings[0].runs).toBe(1);
    expect(standings[0].agentName).toBe("arena-entrant");
  });

  it("carries the most recent submission's github_login, falling back to 'unknown' when none has ever been set", () => {
    const withLogin = { ...sub("s1", "alice", "SAME", "2026-07-20T00:00:00Z"), github_login: "octocat" };
    const withoutLogin = sub("s2", "bob", "SAME", "2026-07-21T00:00:00Z"); // newer, no login (pre-login submission)
    const runs = [run("r1", "s1", [true, true, false, false]), run("r2", "s2", [true, true, true, false])];
    const [standing] = aggregatePrompts(runs, [withLogin, withoutLogin], TOTAL);
    // s2 is more recent and sets agentName, but its missing github_login must
    // not regress a known-good login back to "unknown" (same `?? previous`
    // convention already used for agentName).
    expect(standing.agentName).toBe("bob");
    expect(standing.githubLogin).toBe("octocat");

    // No submission in the group has ever had a login -> "unknown".
    const noLoginOnly = aggregatePrompts(
      [run("r0", "s0", [true, false, false, false])],
      [sub("s0", "eve", "NEVER LOGGED IN", "2026-07-20T00:00:00Z")],
      TOTAL,
    );
    expect(noLoginOnly[0].githubLogin).toBe("unknown");

    // Reversed recency: the newer submission DOES have a login -> that one wins.
    const withoutLoginOlder = sub("s3", "carol", "SAME2", "2026-07-20T00:00:00Z");
    const withLoginNewer = { ...sub("s4", "dave", "SAME2", "2026-07-21T00:00:00Z"), github_login: "hubcat" };
    const [standing2] = aggregatePrompts(
      [run("r3", "s3", [true, false, false, false]), run("r4", "s4", [true, true, false, false])],
      [withoutLoginOlder, withLoginNewer],
      TOTAL,
    );
    expect(standing2.githubLogin).toBe("hubcat");
  });

  it("groups a whitespace-only prompt into the same baseline standing as an actually-empty prompt", () => {
    const submissions = [
      sub("s1", "restore-check", "", "2026-07-20T00:00:00Z"),
      sub("s2", "p2", "   ", "2026-07-21T00:00:00Z"),
    ];
    const runs = [
      run("r1", "s1", [true, true, false, false]),
      run("r2", "s2", [true, true, true, false]),
    ];
    const standings = aggregatePrompts(runs, submissions, TOTAL);
    // One standing, not two -- both runs count toward the same baseline mean.
    expect(standings).toHaveLength(1);
    expect(standings[0].promptKey).toBe("");
    expect(standings[0].runs).toBe(2);
  });
});

describe("baselineDisplayName", () => {
  it("labels a baseline standing '<model label> Baseline'", () => {
    expect(baselineDisplayName({ model: "anthropic/claude-sonnet-5" })).toBe("Claude Sonnet 5 Baseline");
    expect(baselineDisplayName({ model: "zai/glm-5.2" })).toBe("glm-5.2 Baseline");
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
    // both runs have no model -> one glm-5.2 group carrying the per-model stats
    expect(stats.byModel).toHaveLength(1);
    const glm = stats.byModel[0];
    expect(glm.model).toBe("zai/glm-5.2");
    expect(glm.passRate).toBeCloseTo(0.5);
    expect(glm.meanTurns).toBeCloseTo(2.5); // (5 + 0) / 2
    expect(glm.meanCostUsd).toBeCloseTo(0.02); // only the 5-turn run counts; 0-turn is unmeasured
    // newest submission (bob, s2 2026-07-21) first, each stamped with its model
    expect(stats.results.map((r) => r.agentName)).toEqual(["bob", "alice"]);
    expect(stats.results.every((r) => r.model === "zai/glm-5.2")).toBe(true);
    expect(stats.results.find((r) => r.agentName === "bob")!.costUsd).toBeNull();
  });

  it("splits a task's attempts by model (glm vs Claude never averaged)", () => {
    const runs = [
      { ...run("r1", "s1", [true, false, false, false], undefined, "completed", [0.02, 0, 0, 0], [5, 0, 0, 0]), model: "zai/glm-5.2" },
      { ...run("r2", "s2", [false, false, false, false], undefined, "completed", [0.3, 0, 0, 0], [9, 0, 0, 0]), model: "anthropic/claude-sonnet-5" },
    ];
    const stats = aggregateTask(runs, subs, "t0")!;
    const byModel = Object.fromEntries(stats.byModel.map((m) => [m.model, m]));
    expect(byModel["zai/glm-5.2"].passRate).toBe(1);
    expect(byModel["anthropic/claude-sonnet-5"].passRate).toBe(0);
    expect(byModel["anthropic/claude-sonnet-5"].meanCostUsd).toBeCloseTo(0.3);
  });

  it("returns null when no completed run recorded the task", () => {
    const runs = [run("r1", "s1", [true, false, false, false], undefined, "running")];
    expect(aggregateTask(runs, subs, "t0")).toBeNull();
  });

  it("excludes competition submissions from the per-task view too", () => {
    const compSubs = [
      { ...sub("s1", "arena-entrant", "P1", "2026-07-20T00:00:00Z") },
      { ...sub("s2", "comp-entrant", "P2", "2026-07-21T00:00:00Z"), competition: true },
    ];
    const runs = [run("r1", "s1", [true, false, false, false]), run("r2", "s2", [true, true, true, true])];
    const stats = aggregateTask(runs, compSubs, "t0")!;
    expect(stats.attempts).toBe(1);
    expect(stats.results[0].agentName).toBe("arena-entrant");
  });
});

describe("aggregateAllRunsByTask", () => {
  const subs = [
    sub("s1", "vanilla", "", "2026-07-20T00:00:00Z"),
    sub("s2", "prompty", "P2", "2026-07-21T00:00:00Z"),
  ];

  it("totals per-task across runs and splits perModel; sorts by difficulty", () => {
    const runs = [
      run("r1", "s1", [true, false, false, false]),
      run("r2", "s2", [true, true, false, false]),
    ];
    const perTask = aggregateAllRunsByTask(runs, subs, ["t0", "t1", "t2", "t3"]);
    const byId = Object.fromEntries(perTask.map((t) => [t.taskId, t]));
    // t0 passed in both runs, t1 in one, t2/t3 in neither.
    expect(byId.t0).toMatchObject({ passed: 2, of: 2 });
    expect(byId.t1).toMatchObject({ passed: 1, of: 2 });
    expect(byId.t2).toMatchObject({ passed: 0, of: 2 });
    // both runs are glm (no model) -> a single glm perModel entry
    expect(byId.t0.perModel).toHaveLength(1);
    expect(byId.t0.perModel[0]).toMatchObject({ model: "zai/glm-5.2", passed: 2, attempts: 2 });
    // sorted by overall rate desc, then id: t0 (1.0), t1 (0.5), t2, t3
    expect(perTask.map((t) => t.taskId)).toEqual(["t0", "t1", "t2", "t3"]);
  });

  it("omits tasks no completed run has recorded", () => {
    const runs = [run("r1", "s1", [true, false, false, false])];
    const perTask = aggregateAllRunsByTask(runs, subs, ["t0", "t9-never-run"]);
    expect(perTask.map((t) => t.taskId)).toEqual(["t0"]);
  });

  it("excludes competition submissions from the homepage per-task overview", () => {
    const compSubs = [
      { ...sub("s1", "arena-entrant", "P1", "2026-07-20T00:00:00Z") },
      { ...sub("s2", "comp-entrant", "P2", "2026-07-21T00:00:00Z"), competition: true },
    ];
    const runs = [run("r1", "s1", [true, false, false, false]), run("r2", "s2", [true, true, true, true])];
    const perTask = aggregateAllRunsByTask(runs, compSubs, ["t0"]);
    expect(perTask[0]).toMatchObject({ passed: 1, of: 1 });
  });

  it("excludes entries from BOTH competitions, not just one (issue #76)", () => {
    const compSubs = [
      sub("s1", "arena-entrant", "P1", "2026-07-20T00:00:00Z"),
      { ...sub("s2", "comp-a-entrant", "P2", "2026-07-21T00:00:00Z"), competition: true, competition_id: "comp-a" },
      { ...sub("s3", "comp-b-entrant", "P3", "2026-07-22T00:00:00Z"), competition: true, competition_id: "comp-b" },
    ];
    const runs = [
      run("r1", "s1", [true, false, false, false]),
      run("r2", "s2", [true, true, true, true]),
      run("r3", "s3", [true, true, true, true]),
    ];
    const perTask = aggregateAllRunsByTask(runs, compSubs, ["t0"]);
    expect(perTask[0]).toMatchObject({ passed: 1, of: 1 });
  });

// A standing's mean is an estimate from 3-5 noisy runs. Production data shows a
// within-prompt sd of ~0.78 tasks, so adjacent standings are frequently not
// distinguishable -- see docs/measurement-and-variance.md. The board should say
// how precise the number is rather than implying exactness.
describe("run-to-run spread", () => {
  it("reports the standard error of the mean across a standing's runs", () => {
    const submissions = [sub("s1", "agent", "p", "2026-07-21T00:00:00.000Z")];
    const runs = [
      run("r1", "s1", [true, true, true, true, true, true, false, false, false, false, false, false, false, false, false, false]),
      run("r2", "s1", [true, true, true, true, true, true, true, true, false, false, false, false, false, false, false, false]),
      run("r3", "s1", [true, true, true, true, true, true, true, true, true, true, false, false, false, false, false, false]),
    ];

    const [standing] = aggregatePrompts(runs, submissions, 16);

    // tasks 6, 8, 10 -> mean 8, sd 2, sem 2/sqrt(3)
    expect(standing.meanTasksPassed).toBe(8);
    expect(standing.tasksPassedSem).toBeCloseTo(2 / Math.sqrt(3), 5);
  });

  it("reports no spread for a single run, rather than a fake zero", () => {
    const [standing] = aggregatePrompts([run("r1", "s1", [true, true, true, true, true, true, true, false, false, false, false, false, false, false, false, false])], [sub("s1", "agent", "p", "2026-07-21T00:00:00.000Z")], 16);

    // One sample has no measurable spread. Reporting 0 would claim certainty
    // the single run cannot support.
    expect(standing.tasksPassedSem).toBeNull();
  });

  it("reports zero spread only when repeated runs genuinely agree", () => {
    const runs = [run("r1", "s1", [true, true, true, true, true, true, true, true, true, false, false, false, false, false, false, false]), run("r2", "s1", [true, true, true, true, true, true, true, true, true, false, false, false, false, false, false, false]), run("r3", "s1", [true, true, true, true, true, true, true, true, true, false, false, false, false, false, false, false])];

    const [standing] = aggregatePrompts(runs, [sub("s1", "agent", "p", "2026-07-21T00:00:00.000Z")], 16);

    expect(standing.tasksPassedSem).toBe(0);
  });
});
});

// Runs recorded before provider pinning sampled an unknown mix of upstreams,
// so they are not strictly comparable with pinned runs. The board has to say
// so rather than silently ranking them together.
describe("pre-pinning runs", () => {
  it("flags a standing whose runs predate provider pinning", () => {
    const flags = Array(16).fill(false);
    const [standing] = aggregatePrompts(
      [run("r1", "s1", flags)],
      [sub("s1", "agent", "p", "2026-07-21T00:00:00.000Z")],
      16,
    );

    expect(standing.prePinningRuns).toBe(1);
  });

  it("does not flag a standing whose runs were pinned", () => {
    const flags = Array(16).fill(false);
    const pinned = { ...run("r1", "s1", flags), provider_pinned: "zai" };
    const [standing] = aggregatePrompts(
      [pinned],
      [sub("s1", "agent", "p", "2026-07-21T00:00:00.000Z")],
      16,
    );

    expect(standing.prePinningRuns).toBe(0);
  });

  it("counts a mixed standing, because averaging across the cutover is the thing to warn about", () => {
    const flags = Array(16).fill(false);
    const runs = [run("r1", "s1", flags), { ...run("r2", "s1", flags), provider_pinned: "zai" }];
    const [standing] = aggregatePrompts(
      runs,
      [sub("s1", "agent", "p", "2026-07-21T00:00:00.000Z")],
      16,
    );

    expect(standing.prePinningRuns).toBe(1);
    expect(standing.runs).toBe(2);
  });
});
