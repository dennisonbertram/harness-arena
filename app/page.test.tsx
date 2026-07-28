import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";
import { defaultCompetitionId } from "@/lib/competition-leaderboard";
import type { Competition, Run, Submission } from "@/lib/types";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn() }));

import { auth } from "@/auth";
import { asMockAuth, githubSession } from "@/lib/test-support/auth-mock";
import * as CompetitionPage from "./page";

const mockAuth = asMockAuth(auth);

describe("competition page revalidation", () => {
  it("exports a 15-second ISR revalidate window, matching the main leaderboard", () => {
    expect(CompetitionPage.revalidate).toBe(15);
  });
});

describe("CompetitionPage", () => {
  beforeEach(() => {
    resetStorage();
    mockAuth.mockReset();
  });

  it("renders a sign-in prompt in place of the submit form when signed out", async () => {
    mockAuth.mockResolvedValue(null);
    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toContain("Sign in with GitHub to submit an agent");
    expect(html).not.toContain("Signed in as");
  });

  it("renders the submit form and the signed-in login when signed in", async () => {
    mockAuth.mockResolvedValue(githubSession(1, "octocat"));
    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toContain("Signed in as");
    expect(html).toContain("octocat");
  });

  it("renders the empty-leaderboard message, not the table, when there are no ranked entries", async () => {
    mockAuth.mockResolvedValue(null);
    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toContain("No entries yet — beat the baseline.");
  });

  it("shows only the live default competition's entries, not another competition's (issue #76)", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    const defaultId = defaultCompetitionId();

    const competition = (id: string, overrides: Partial<Competition> = {}): Competition => ({
      id,
      arena: "harness-arena",
      harness: "pi",
      model: "zai/glm-5.2",
      status: "live",
      created_at: "2026-07-25T00:00:00.000Z",
      ...overrides,
    });
    const sub = (id: string, overrides: Partial<Submission> = {}): Submission => ({
      id,
      agent_name: "entrant",
      prompt: `prompt-${id}`,
      status: "scored",
      competition: true,
      created_at: "2026-07-25T00:00:00.000Z",
      ...overrides,
    });
    const run = (id: string, overrides: Partial<Run> = {}): Run => ({
      id,
      submission_id: overrides.submission_id ?? "unset",
      status: "completed",
      tasks_passed: 10,
      total_cost_usd: 1.0,
      task_results: Array(16).fill({ task_id: "t", attempted: true, passed: true }),
      created_at: "2026-07-25T00:00:00.000Z",
      ...overrides,
    });

    await storage.putCompetition(competition(defaultId));
    await storage.putCompetition(competition("comp-other", { status: "live" }));
    await storage.putSubmission(sub("s1", { run_id: "r1", competition_id: defaultId, github_login: "default-entrant" }));
    await storage.putRun(run("r1", { submission_id: "s1" }));
    await storage.putSubmission(sub("s2", { run_id: "r2", competition_id: "comp-other", github_login: "other-entrant" }));
    await storage.putRun(run("r2", { submission_id: "s2" }));

    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toContain("default-entrant");
    expect(html).not.toContain("other-entrant");
  });

  it("renders no prize amount or cadence when both are unset", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition({ prize_amount_usd: null, prize_cadence: null }));

    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).not.toMatch(/\$\d/);
    expect(html).not.toMatch(/\b(?:daily|weekly|monthly|one-time)\b/i);
  });

  it("renders the prize amount and cadence supplied by the competition", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition({ prize_amount_usd: 12.5, prize_cadence: "weekly" }));

    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toContain("$12.50");
    expect(html).toContain("weekly");
  });

  // The model is a property of the competition record (#77), not the
  // COMPETITION_MODEL env constant. Showing the constant would display the
  // wrong model for any competition that isn't the seeded default.
  it("shows the competition's own model, not the env default", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition({ model: "anthropic/claude-opus-5" }));

    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toContain("Claude Opus 5");
    expect(html).not.toContain("glm-5.2");
  });

  // formatUsd renders 4 decimals because it exists for fractions-of-a-cent
  // run costs. A prize pot is money a human is owed -- $100.00, not $100.0000.
  it("formats the prize as currency, not as a 4-decimal run cost", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition({ prize_amount_usd: 100, prize_cadence: "weekly" }));

    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toContain("$100.00");
    expect(html).not.toContain("$100.0000");
  });

  it("renders a closed competition as closed", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition({ status: "closed" }));

    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toContain("closed");
    expect(html).not.toContain("This competition is live.");
  });

  it("removes the old payout-mechanics copy", async () => {
    mockAuth.mockResolvedValue(null);
    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).not.toContain("$100");
    expect(html).not.toContain("paid manually");
  });
});

function defaultCompetition(overrides: Partial<Competition> = {}): Competition {
  return {
    id: defaultCompetitionId(),
    arena: "harness-arena",
    harness: "pi",
    model: "zai/glm-5.2",
    prize_amount_usd: null,
    prize_cadence: null,
    status: "live",
    created_at: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}
