import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";
import type { Run, Submission } from "@/lib/types";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

vi.mock("../RerunButton", () => ({
  RerunButton: ({ agentName }: { agentName: string }) => <button type="button">Rerun {agentName}</button>,
}));

import * as LeaderboardPage from "./page";

describe("leaderboard page revalidation", () => {
  it("exports a 15-second ISR revalidate window so the leaderboard isn't cached forever at build time", () => {
    expect(LeaderboardPage.revalidate).toBe(15);
  });
});

describe("benchmarks board", () => {
  beforeEach(() => {
    resetStorage();
  });

  it("renders the empty state and a plural live-status link when no run is scored", async () => {
    const storage = storageRef.current;
    await storage.putRun(run("queued", { status: "queued" }));
    await storage.putRun(run("running", { status: "running" }));

    const html = renderToStaticMarkup(await LeaderboardPage.default());

    expect(html).toContain("No scored runs yet — be the first.");
    expect(html).toContain('href="/submit"');
    expect(html).toContain('href="/pending"');
    expect(html).toContain("2 runs in progress — see live status →");
    expect(html).not.toContain("Cost vs. tasks passed");
  });

  it("renders main-arena standings, chart, and task rates while excluding competition entries", async () => {
    const storage = storageRef.current;
    await storage.putSubmission(submission("entrant", {
      agent_name: "Precision Agent",
      github_login: "octocat",
      prompt: "Solve every task carefully",
      model: "anthropic/claude-sonnet-5",
    }));
    await storage.putSubmission(submission("baseline", {
      agent_name: "manual baseline name",
      github_login: "baseline-account-must-not-render",
      prompt: "   ",
      model: "zai/glm-5.2",
    }));
    await storage.putSubmission(submission("competition", {
      agent_name: "Competition-only entrant",
      github_login: "competition-account-must-not-render",
      prompt: "This must stay off the board",
      competition: true,
    }));

    await storage.putRun(run("entrant-run", {
      submission_id: "entrant",
      model: "anthropic/claude-sonnet-5",
      tasks_passed: 16,
      total_cost_usd: 1.25,
      task_results: [
        { task_id: "fix-git", attempted: true, passed: true, turns: 3, cost_usd: 0.2 },
        { task_id: "headless-terminal", attempted: true, passed: true, turns: 2, cost_usd: 0.3 },
      ],
    }));
    await storage.putRun(run("baseline-run", {
      submission_id: "baseline",
      tasks_passed: 8,
      total_cost_usd: undefined,
      task_results: [{ task_id: "fix-git", attempted: true, passed: false, turns: 1, cost_usd: 0.1 }],
    }));
    await storage.putRun(run("competition-run", {
      submission_id: "competition",
      tasks_passed: 15,
      total_cost_usd: 0.05,
      task_results: [{ task_id: "fix-git", attempted: true, passed: true }],
    }));
    await storage.putRun(run("live-run", { status: "running" }));

    const html = renderToStaticMarkup(await LeaderboardPage.default());

    expect(html).toContain("Leaderboard");
    expect(html).toContain("Precision Agent");
    expect(html).toContain("octocat");
    expect(html).toContain("100%");
    expect(html).toContain("· complete");
    expect(html).toContain("Claude Sonnet 5");
    expect(html).toContain("$1.2500");
    expect(html).toContain("glm-5.2 Baseline");
    expect(html).toContain("Median run cost");
    expect(html).toContain("—");
    expect(html).toContain("1 run in progress — see live status →");
    expect(html).toContain("Cost vs. tasks passed");
    expect(html).toContain("Per-task pass rate");
    expect(html).toContain("fix-git");
    expect(html).toContain("headless-terminal");
    expect(html).toContain('src="https://github.com/octocat.png?size=40"');
    expect(html).toMatch(/<svg viewBox="0 0 24 24" width="12" height="12">[\s\S]*?<\/svg><\/span><a href="\/runs\/baseline-run">glm-5\.2 Baseline<\/a>/);
    expect(html).not.toContain("baseline-account-must-not-render");
    expect(html).not.toContain("Competition-only entrant");
    expect(html).not.toContain("competition-account-must-not-render");
    expect(html).not.toContain("This must stay off the board");
  });
});

function submission(id: string, overrides: Partial<Submission> = {}): Submission {
  return {
    id,
    agent_name: "agent",
    prompt: `prompt-${id}`,
    status: "scored",
    created_at: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    submission_id: "missing-submission",
    status: "completed",
    tasks_passed: 1,
    total_cost_usd: 0.5,
    task_results: [],
    created_at: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}
