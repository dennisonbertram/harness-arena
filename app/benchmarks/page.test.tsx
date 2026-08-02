import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";
import type { Competition, Run, Submission } from "@/lib/types";

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn() }));

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

vi.mock("../RerunButton", () => ({
  RerunButton: ({ agentName }: { agentName: string }) => <button type="button">Rerun {agentName}</button>,
}));

import * as LeaderboardPage from "./page";

import { auth as mockedAuth } from "@/auth";

// Default to the operator so assertions about standings still see the Rerun
// control; the gate tests below override this explicitly.
beforeEach(() => {
  vi.mocked(mockedAuth).mockResolvedValue({ user: { githubLogin: "dennisonbertram" } } as never);
});

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

    expect(html).toContain("No scored prompt runs yet — be the first.");
    expect(html).toContain('href="/submit"');
    expect(html).toContain('href="/pending"');
    expect(html).toContain("2 runs in progress — see live status →");
    expect(html).not.toContain("Cost vs. tasks passed");
  });

  it("renders main-arena standings separately from completed competition benchmark runs", async () => {
    const storage = storageRef.current;
    await storage.putCompetition(competition("inkling-baseten", {
      model: "thinkingmachines/inkling-small",
      gateway_provider: "baseten",
      status: "closed",
    }));
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
      agent_name: "Contract First",
      github_login: "competition-account",
      prompt: "This must stay off the board",
      competition: true,
      competition_id: "inkling-baseten",
      model: "thinkingmachines/inkling-small",
      gateway_provider: "baseten",
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
      model: "thinkingmachines/inkling-small",
      provider_requested: "baseten",
      provider_pinned: "baseten",
      tasks_passed: 12,
      total_cost_usd: 1.0912,
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
    const competitionSection = html.match(
      /<section[^>]*data-benchmark-source="competition"[\s\S]*?<\/section>/,
    )?.[0];
    expect(competitionSection).toBeDefined();
    expect(competitionSection).toContain("Competition runs");
    expect(competitionSection).toContain("Contract First");
    expect(competitionSection).toContain("competition-account");
    expect(competitionSection).toContain("Inkling Small");
    expect(competitionSection).toContain("baseten");
    expect(competitionSection).toContain("12/16");
    expect(competitionSection).toContain("$1.0912");
    expect(competitionSection).toContain('href="/runs/competition-run"');
    expect(competitionSection).toContain('href="/?competition=inkling-baseten"');
    expect(html).not.toContain("This must stay off the board");
  });

  it("shows completed competition runs even when there are no scored main-arena prompts", async () => {
    const storage = resetStorage();
    await storage.putCompetition(competition("inkling-baseten", {
      model: "thinkingmachines/inkling-small",
      gateway_provider: "baseten",
    }));
    await storage.putSubmission(submission("competition-only", {
      agent_name: "Evidence Loop",
      github_login: "octocat",
      competition: true,
      competition_id: "inkling-baseten",
      model: "thinkingmachines/inkling-small",
    }));
    await storage.putRun(run("competition-only-run", {
      submission_id: "competition-only",
      model: "thinkingmachines/inkling-small",
      provider_pinned: "baseten",
      tasks_passed: 8,
      total_cost_usd: 0.5579,
      task_results: Array.from({ length: 16 }, (_, index) => ({
        task_id: `task-${index}`,
        attempted: true,
        passed: index < 8,
      })),
    }));

    const html = renderToStaticMarkup(await LeaderboardPage.default());

    expect(html).toContain("No scored prompt runs yet");
    expect(html).toContain("Competition runs");
    expect(html).toContain("Evidence Loop");
    expect(html).toContain('href="/runs/competition-only-run"');
  });

  // Every model on the allowlist has a provider logomark (ModelLogo); the
  // Model column showed only the text label, so the board was harder to scan
  // by provider than the rows already were by entrant.
  it("shows a provider logomark beside each model name", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("s1", { run_id: "r1", model: "anthropic/claude-opus-5" }));
    await storage.putRun(run("r1", { submission_id: "s1", model: "anthropic/claude-opus-5" }));

    const html = renderToStaticMarkup(await LeaderboardPage.default());

    // Anthropic's mark, from ModelLogo's PROVIDER_LOGOS.
    expect(html).toContain("M17.3041 3.541h-3.6718l6.696 16.918H24Z");
  });

  // Adjacent standings are frequently not distinguishable at the measured
  // sd (~0.78 tasks), so the board shows the interval rather than implying
  // the mean is exact. See docs/measurement-and-variance.md.
  it("shows the ± on the mean when a standing has repeated runs", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("s1", { run_id: "r1" }));
    await storage.putRun(run("r1", { submission_id: "s1", tasks_passed: 6 }));
    await storage.putRun(run("r2", { submission_id: "s1", tasks_passed: 10 }));

    const html = renderToStaticMarkup(await LeaderboardPage.default());

    expect(html).toContain("±");
  });

  // Rerun spends money re-running someone else's prompt. Hiding it from
  // visitors is a UI affordance, not an authorization boundary — the endpoint
  // it posts to is the same public submit endpoint (see RERUN_OPERATOR_LOGIN).
  it("hides Rerun from a signed-out visitor", async () => {
    vi.mocked(mockedAuth).mockResolvedValue(null as never);
    const storage = resetStorage();
    await storage.putSubmission(submission("s1", { run_id: "r1" }));
    await storage.putRun(run("r1", { submission_id: "s1" }));

    const html = renderToStaticMarkup(await LeaderboardPage.default());

    expect(html).not.toContain("Rerun");
  });

  it("hides Rerun from a signed-in user who is not the operator", async () => {
    vi.mocked(mockedAuth).mockResolvedValue({ user: { githubLogin: "someone-else" } } as never);
    const storage = resetStorage();
    await storage.putSubmission(submission("s1", { run_id: "r1" }));
    await storage.putRun(run("r1", { submission_id: "s1" }));

    const html = renderToStaticMarkup(await LeaderboardPage.default());

    expect(html).not.toContain("Rerun");
  });

  it("shows Rerun to the operator", async () => {
    vi.mocked(mockedAuth).mockResolvedValue({ user: { githubLogin: "dennisonbertram" } } as never);
    const storage = resetStorage();
    await storage.putSubmission(submission("s1", { run_id: "r1" }));
    await storage.putRun(run("r1", { submission_id: "s1" }));

    const html = renderToStaticMarkup(await LeaderboardPage.default());

    expect(html).toContain("Rerun");
  });

  // Old runs sampled an unknown mix of gateway upstreams. Ranking them silently
  // beside pinned runs would compare two different measurements.
  it("marks a standing whose runs predate provider pinning", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("s1", { run_id: "r1" }));
    await storage.putRun(run("r1", { submission_id: "s1" }));

    const html = renderToStaticMarkup(await LeaderboardPage.default());

    expect(html).toContain("unpinned");
  });

  it("does not mark a standing whose runs were pinned", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("s1", { run_id: "r1" }));
    await storage.putRun({ ...run("r1", { submission_id: "s1" }), provider_pinned: "zai" });

    const html = renderToStaticMarkup(await LeaderboardPage.default());

    expect(html).not.toContain("unpinned");
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

function competition(id: string, overrides: Partial<Competition> = {}): Competition {
  return {
    id,
    arena: "harness-arena",
    harness: "pi",
    model: "zai/glm-5.2",
    gateway_provider: "wafer",
    status: "live",
    created_at: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}
