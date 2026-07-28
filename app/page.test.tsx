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

  it("moves submission into an accessible modal triggered before the leaderboard when signed out (issue #81)", async () => {
    mockAuth.mockResolvedValue(null);
    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toContain("Submit a prompt");
    expect(html.indexOf("Submit a prompt")).toBeLessThan(html.indexOf("Leaderboard"));
    expect(html).not.toContain("margin-top:48px;max-width:640px");
    expect(html).toMatch(
      /<dialog[^>]*id="competition-submit-modal"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="competition-submit-modal-heading"/,
    );
    expect(html).toContain('<h2 id="competition-submit-modal-heading"');
    expect(html).toMatch(/<dialog[^>]*>[\s\S]*Sign in with GitHub to submit an agent[\s\S]*Sign in with GitHub[\s\S]*<\/dialog>/);
    expect(html).not.toContain("Signed in as");
  });

  it("renders the signed-in submission form inside the modal (issue #81)", async () => {
    mockAuth.mockResolvedValue(githubSession(1, "octocat"));
    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toMatch(/<dialog[^>]*>[\s\S]*Signed in as[\s\S]*octocat[\s\S]*Agent name[\s\S]*<\/dialog>/);
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

  it("renders the selected competition's board instead of the default's (issue #78)", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    const defaultId = defaultCompetitionId();
    const selectedId = "comp-second";
    await storage.putCompetition(defaultCompetition());
    await storage.putCompetition(
      defaultCompetition({
        id: selectedId,
        arena: "bounty-arena",
        harness: "codex",
        model: "anthropic/claude-opus-5",
      }),
    );
    await storage.putSubmission(submission("default-entry", { run_id: "run-default", competition_id: defaultId, github_login: "default-entrant" }));
    await storage.putRun(run("run-default", { submission_id: "default-entry" }));
    await storage.putSubmission(submission("selected-entry", { run_id: "run-selected", competition_id: selectedId, github_login: "selected-entrant" }));
    await storage.putRun(run("run-selected", { submission_id: "selected-entry" }));

    const html = renderToStaticMarkup(
      await CompetitionPage.default({ searchParams: Promise.resolve({ competition: selectedId }) }),
    );

    expect(html).toContain("selected-entrant");
    expect(html).not.toContain("default-entrant");
    expect(html).toContain("Bounty Arena");
    expect(html).toContain("Codex");
    expect(html).toContain("Claude Opus 5");
  });

  it("renders a deliberate three-level switcher when there is one competition (issue #78)", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition());

    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toContain("Competition");
    expect(html).toContain("Arena");
    expect(html).toContain("Harness");
    expect(html).toContain("Model");
    expect(html).toContain("Harness Arena");
    expect(html).toContain("Pi");
    expect(html).toContain("glm-5.2");
  });

  it("falls back to the default competition when the URL competition id is unknown (issue #78)", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition());
    await storage.putSubmission(submission("default-entry", { run_id: "run-default", github_login: "default-entrant" }));
    await storage.putRun(run("run-default", { submission_id: "default-entry" }));

    const html = renderToStaticMarkup(
      await CompetitionPage.default({ searchParams: Promise.resolve({ competition: "not-a-competition" }) }),
    );

    expect(html).toContain("default-entrant");
  });

  // The switcher shows Arena/Harness/Model, so repeating harness and model in
  // the meta box states the same facts twice on one screen. The meta box keeps
  // only what the switcher does not carry.
  it("does not repeat the harness and model values now the switcher shows them", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition({ harness: "pi", model: "zai/glm-5.2" }));

    const html = renderToStaticMarkup(await CompetitionPage.default());

    // The switcher renders the harness as "Pi" and the model as "glm-5.2";
    // each must appear exactly once on the page, not once here and once in
    // the meta box.
    expect(html.match(/>Pi</gi) ?? []).toHaveLength(1);
    expect(html.match(/>glm-5\.2</g) ?? []).toHaveLength(1);
  });

  // Selecting a competition must change where a submission GOES, not just what
  // the page shows. The prop wiring itself (competitionId on the form,
  // redirectTo on the sign-in button) is invisible in rendered HTML and is
  // covered by types plus the API's own competition_id tests; what IS
  // assertable here is that every switcher link carries the competition id, so
  // a shared link and a sign-in round-trip both land on the same board.
  it("addresses every competition by id in the switcher links", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition());
    await storage.putCompetition(defaultCompetition({ id: "comp-other", model: "anthropic/claude-opus-5" }));

    const html = renderToStaticMarkup(
      await CompetitionPage.default({ searchParams: Promise.resolve({ competition: "comp-other" }) }),
    );

    expect(html).toContain(`/?competition=${encodeURIComponent("comp-other")}`);
    expect(html).toContain(`/?competition=${encodeURIComponent(defaultCompetitionId())}`);
  });

  // The representative competition for an arena/harness usually has a
  // different id than the selected one, so comparing ids left the parent pills
  // unstyled and without aria-current.
  it("marks the arena and harness pills current, not just the model pill", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition());
    await storage.putCompetition(defaultCompetition({ id: "comp-other", model: "anthropic/claude-opus-5" }));

    const html = renderToStaticMarkup(
      await CompetitionPage.default({ searchParams: Promise.resolve({ competition: "comp-other" }) }),
    );

    // Arena, harness and model pills are all on the selected dimension.
    expect(html.match(/aria-current="page"/g) ?? []).toHaveLength(3);
  });

  // A closed competition rejects submissions with 409, and the form maps every
  // 409 to "Prompt already submitted" -- so an entrant would be told their
  // prompt was a duplicate when it was never stored. Don't offer the flow at
  // all once the contest is closed.
  it("does not offer submission for a closed competition", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition({ status: "closed" }));

    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).not.toContain("Submit a prompt");
    expect(html).toContain("closed");
  });

  it("renders no prize amount or cadence when both are unset (issue #78)", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition({ prize_amount_usd: null, prize_cadence: null }));

    const html = renderToStaticMarkup(
      await CompetitionPage.default({ searchParams: Promise.resolve({ competition: defaultCompetitionId() }) }),
    );

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

  it("renders a selected closed competition as closed (issue #78)", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition({ status: "closed" }));

    const html = renderToStaticMarkup(
      await CompetitionPage.default({ searchParams: Promise.resolve({ competition: defaultCompetitionId() }) }),
    );

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

function submission(id: string, overrides: Partial<Submission> = {}): Submission {
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
    tasks_passed: 10,
    total_cost_usd: 1,
    task_results: Array(16).fill({ task_id: "t", attempted: true, passed: true }),
    created_at: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}
