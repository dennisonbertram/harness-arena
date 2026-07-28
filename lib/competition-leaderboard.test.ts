import { describe, expect, it } from "vitest";
import {
  defaultCompetitionId,
  getCompetitionBoard,
  rankCompetition,
  resolveDefaultCompetition,
  type CompetitionRow,
} from "./competition-leaderboard";
import { MemoryStorage } from "./storage";
import type { Competition, Run, Submission } from "./types";

const DEFAULT_ID = defaultCompetitionId();

function competition(id: string, overrides: Partial<Competition> = {}): Competition {
  return {
    id,
    arena: "harness-arena",
    harness: "pi",
    model: "zai/glm-5.2",
    status: "live",
    created_at: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

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
    githubLogin: "unknown",
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

    const board = await getCompetitionBoard(storage, DEFAULT_ID);
    expect(board.ranked).toHaveLength(1);
    expect(board.ranked[0].submissionId).toBe("s1");
    expect(board.pending).toBe(1);
  });

  it("carries the entrant's github_login onto the ranked row, falling back to 'unknown' when unset", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("s1", { run_id: "r1", github_login: "octocat" }));
    await storage.putRun(run("r1", { submission_id: "s1", tasks_passed: 10, total_cost_usd: 1.0, task_results: Array(16).fill({ task_id: "t", attempted: true, passed: true }) }));

    const board = await getCompetitionBoard(storage, DEFAULT_ID);
    expect(board.ranked[0].githubLogin).toBe("octocat");
  });

  it("excludes a non-competition submission entirely, even with a great score", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("s1", { run_id: "r1", competition: false }));
    await storage.putRun(run("r1", { submission_id: "s1", tasks_passed: 16, total_cost_usd: 0.5 }));

    const board = await getCompetitionBoard(storage, DEFAULT_ID);
    expect(board.ranked).toHaveLength(0);
  });

  it("reports baselineState 'none' when no baseline submission exists", async () => {
    const storage = new MemoryStorage();
    const board = await getCompetitionBoard(storage, DEFAULT_ID);
    expect(board.baselineState).toBe("none");
    expect(board.baseline).toBeNull();
  });

  it("reports baselineState 'running' when the baseline's run hasn't completed", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("base", { run_id: "rb", competition_baseline: true }));
    await storage.putRun(run("rb", { submission_id: "base", status: "queued", task_results: [] }));

    const board = await getCompetitionBoard(storage, DEFAULT_ID);
    expect(board.baselineState).toBe("running");
    expect(board.baseline).toBeNull();
  });

  it("reports baselineState 'rejected' with the judge's reason when the baseline was rejected", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("base", { competition_baseline: true, status: "rejected", judge_reason: "flagged" }));

    const board = await getCompetitionBoard(storage, DEFAULT_ID);
    expect(board.baselineState).toBe("rejected");
    expect(board.baselineRejectionReason).toBe("flagged");
  });

  it("reports baselineState 'ready' and populates baseline once its run completes", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("base", { run_id: "rb", competition_baseline: true }));
    await storage.putRun(run("rb", { submission_id: "base", tasks_passed: 6, total_cost_usd: 0.9, task_results: Array(16).fill({ task_id: "t", attempted: true, passed: false }) }));

    const board = await getCompetitionBoard(storage, DEFAULT_ID);
    expect(board.baselineState).toBe("ready");
    expect(board.baseline?.tasksPassed).toBe(6);
  });

  it("does not count the baseline submission among the ranked competitor rows", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("base", { run_id: "rb", competition_baseline: true }));
    await storage.putRun(run("rb", { submission_id: "base", tasks_passed: 6, total_cost_usd: 0.9, task_results: Array(16).fill({ task_id: "t", attempted: true, passed: false }) }));

    const board = await getCompetitionBoard(storage, DEFAULT_ID);
    expect(board.ranked).toHaveLength(0);
  });

  it("no completed competition runs yet -> ranked is empty", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("s1", { run_id: "r1" }));
    await storage.putRun(run("r1", { submission_id: "s1", status: "running", task_results: [] }));

    const board = await getCompetitionBoard(storage, DEFAULT_ID);
    expect(board.ranked).toEqual([]);
  });
});

describe("getCompetitionBoard — competition scoping (issue #76)", () => {
  const OTHER_ID = "comp-harness-arena-pi-other-model";

  it("two competitions with entries do not bleed into each other's boards", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("s1", { run_id: "r1", competition_id: DEFAULT_ID }));
    await storage.putRun(
      run("r1", { submission_id: "s1", tasks_passed: 10, total_cost_usd: 1.0, task_results: Array(16).fill({ task_id: "t", attempted: true, passed: true }) }),
    );
    await storage.putSubmission(sub("s2", { run_id: "r2", competition_id: OTHER_ID }));
    await storage.putRun(
      run("r2", { submission_id: "s2", tasks_passed: 16, total_cost_usd: 0.2, task_results: Array(16).fill({ task_id: "t", attempted: true, passed: true }) }),
    );

    const defaultBoard = await getCompetitionBoard(storage, DEFAULT_ID);
    const otherBoard = await getCompetitionBoard(storage, OTHER_ID);

    expect(defaultBoard.ranked.map((r) => r.submissionId)).toEqual(["s1"]);
    expect(otherBoard.ranked.map((r) => r.submissionId)).toEqual(["s2"]);
  });

  it("a legacy submission (competition: true, no competition_id) lands in the default competition's board only", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("legacy", { run_id: "r1" })); // no competition_id -- unbackfilled row
    await storage.putRun(
      run("r1", { submission_id: "legacy", tasks_passed: 9, total_cost_usd: 1.5, task_results: Array(16).fill({ task_id: "t", attempted: true, passed: true }) }),
    );

    const defaultBoard = await getCompetitionBoard(storage, DEFAULT_ID);
    const otherBoard = await getCompetitionBoard(storage, OTHER_ID);

    expect(defaultBoard.ranked.map((r) => r.submissionId)).toEqual(["legacy"]);
    expect(otherBoard.ranked).toEqual([]);
  });

  it("resolves per-competition baselines independently", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(sub("base1", { run_id: "rb1", competition_id: DEFAULT_ID, competition_baseline: true }));
    await storage.putRun(
      run("rb1", { submission_id: "base1", tasks_passed: 4, total_cost_usd: 0.5, task_results: Array(16).fill({ task_id: "t", attempted: true, passed: false }) }),
    );
    await storage.putSubmission(sub("base2", { run_id: "rb2", competition_id: OTHER_ID, competition_baseline: true }));
    await storage.putRun(
      run("rb2", { submission_id: "base2", tasks_passed: 12, total_cost_usd: 0.5, task_results: Array(16).fill({ task_id: "t", attempted: true, passed: true }) }),
    );

    const defaultBoard = await getCompetitionBoard(storage, DEFAULT_ID);
    const otherBoard = await getCompetitionBoard(storage, OTHER_ID);

    expect(defaultBoard.baseline?.submissionId).toBe("base1");
    expect(defaultBoard.baseline?.tasksPassed).toBe(4);
    expect(otherBoard.baseline?.submissionId).toBe("base2");
    expect(otherBoard.baseline?.tasksPassed).toBe(12);
  });
});

describe("resolveDefaultCompetition", () => {
  it("prefers the seeded default competition by its deterministic id", async () => {
    const storage = new MemoryStorage();
    await storage.putCompetition(competition("comp-other", { status: "live" }));
    await storage.putCompetition(competition(DEFAULT_ID, { status: "live" }));

    const resolved = await resolveDefaultCompetition(storage);
    expect(resolved?.id).toBe(DEFAULT_ID);
  });

  it("falls back to any live competition when the default id isn't seeded", async () => {
    const storage = new MemoryStorage();
    await storage.putCompetition(competition("comp-only-live", { status: "live" }));

    const resolved = await resolveDefaultCompetition(storage);
    expect(resolved?.id).toBe("comp-only-live");
  });

  it("returns undefined when no competition exists at all", async () => {
    const storage = new MemoryStorage();
    const resolved = await resolveDefaultCompetition(storage);
    expect(resolved).toBeUndefined();
  });

  // Closing is MANUAL (#74), so a closed default is an expected state. Taking
  // it anyway would render a finished contest as the active one -- submission
  // form included -- while a genuinely live competition sits unshown.
  it("skips the seeded default once it's closed and picks a live competition instead", async () => {
    const storage = new MemoryStorage();
    await storage.putCompetition(competition(DEFAULT_ID, { status: "closed" }));
    await storage.putCompetition(competition("comp-next-season", { status: "live" }));

    const resolved = await resolveDefaultCompetition(storage);
    expect(resolved?.id).toBe("comp-next-season");
  });

  it("still returns the closed default when it is the only competition, rather than nothing", async () => {
    const storage = new MemoryStorage();
    await storage.putCompetition(competition(DEFAULT_ID, { status: "closed" }));

    const resolved = await resolveDefaultCompetition(storage);
    expect(resolved?.id).toBe(DEFAULT_ID);
  });
});

// The board's notion of "which competition owns unstamped legacy rows" must
// agree with resolveDefaultCompetition. Re-deriving it from COMPETITION_MODEL
// diverges the moment that env var changes after seeding, and every legacy
// row silently drops off the board -- which matters while the write path
// (#77) still creates submissions without competition_id.
describe("getCompetitionBoard legacy-row ownership", () => {
  it("keeps unstamped rows on the resolved board even when the derived default id isn't seeded", async () => {
    const storage = new MemoryStorage();
    // Simulates COMPETITION_MODEL changed after seeding: the deterministic id
    // resolves to nothing, so the live board carries a different id.
    await storage.putCompetition(competition("comp-seeded-under-old-model", { status: "live" }));
    await storage.putSubmission(sub("legacy", { run_id: "r-legacy" })); // competition:true, no competition_id
    await storage.putRun(run("r-legacy", { submission_id: "legacy", tasks_passed: 5, total_cost_usd: 0.4 }));

    const board = await getCompetitionBoard(storage, "comp-seeded-under-old-model");

    expect(board.ranked.map((r) => r.submissionId)).toContain("legacy");
  });
});
