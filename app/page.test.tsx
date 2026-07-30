import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";
import { defaultCompetitionId } from "@/lib/competition-leaderboard";
import type { Competition, Run, Submission } from "@/lib/types";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

// The page schedules its baseline sweep with next/server's `after`, which
// throws outside a request scope. These tests render the component directly,
// so there is no request — run the callback inline instead. ensureBaselines is
// separately covered in lib/competition-baseline.test.ts.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (fn: () => unknown) => { void fn(); } };
});

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, useRouter: () => ({ push: vi.fn() }) };
});

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn() }));
vi.mock("./CompetitionAutoRefresh", () => ({
  CompetitionAutoRefresh: ({ runIds = [] }: { runIds?: string[] }) => (
    <i data-competition-auto-refresh={runIds.join(",")} />
  ),
}));

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

  it("activates homepage refresh while a competition entry is still running", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition());
    await storage.putSubmission(submission("pending", { status: "running", run_id: "run-pending" }));
    await storage.putRun(
      run("run-pending", {
        submission_id: "pending",
        status: "running",
        tasks_passed: undefined,
        total_cost_usd: undefined,
        task_results: [],
      }),
    );

    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toContain("1 entry still running");
    expect(html).toContain('data-competition-auto-refresh="run-pending"');
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

  it("renders the competition selector and complete metadata when there is one competition (issue #78)", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition({ gateway_provider: "togetherai" }));

    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toContain("Competition");
    expect(html).toContain("Arena");
    expect(html).toContain("Harness");
    expect(html).toContain("Model");
    expect(html).toContain("Provider");
    expect(html).toContain("Harness Arena");
    expect(html).toContain("Pi");
    expect(html).toContain("glm-5.2");
    expect(html).toContain("togetherai");
  });

  it("shows provider-versioned competitions separately even when their arena, harness, and model match", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition({ gateway_provider: "zai" }));
    await storage.putCompetition(
      defaultCompetition({
        id: "comp-morph",
        gateway_provider: "morph",
        created_at: "2026-07-30T00:00:00.000Z",
      }),
    );

    const html = renderToStaticMarkup(
      await CompetitionPage.default({ searchParams: Promise.resolve({ competition: "comp-morph" }) }),
    );

    expect(html).toContain("Provider");
    expect(html).toContain("morph");
    expect(html).toContain("zai");
  });

  it("searches live and closed provider-versioned competitions from one accessible selector", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(
      defaultCompetition({
        id: "comp-wafer",
        model: "zai/glm-5.2-fast",
        gateway_provider: "wafer",
        status: "closed",
        closed_at: "2026-07-30T23:00:00.000Z",
      }),
    );
    await storage.putCompetition(
      defaultCompetition({
        id: "comp-fireworks",
        model: "zai/glm-5.2-fast",
        gateway_provider: "fireworks",
        created_at: "2026-07-31T00:00:00.000Z",
      }),
    );

    const html = renderToStaticMarkup(
      await CompetitionPage.default({ searchParams: Promise.resolve({ competition: "comp-wafer" }) }),
    );

    expect(html).toContain('role="search"');
    expect(html).toContain('<label for="competition-search"');
    expect(html).toContain('<select id="competition-search" name="competition"');
    expect(html).toContain('<optgroup label="Live competitions">');
    expect(html).toContain('<optgroup label="Closed competitions">');
    expect(html).toMatch(/<option value="comp-fireworks"[^>]*>[^<]*fireworks[^<]*live<\/option>/);
    expect(html).toMatch(/<option value="comp-wafer" selected=""[^>]*>[^<]*wafer[^<]*closed<\/option>/);
    expect(html).toContain("View competition");
  });

  it("shows the selected competition's provider and Vercel intermediary as separate metadata", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(
      defaultCompetition({
        model: "zai/glm-5.2-fast",
        gateway_provider: "fireworks",
      }),
    );

    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toMatch(/<dt[^>]*>Provider<\/dt><dd[^>]*>fireworks<\/dd>/);
    expect(html).toMatch(/<dt[^>]*>Intermediary<\/dt><dd[^>]*>Vercel AI Gateway<\/dd>/);
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

  // The selector submits the selected record id through the canonical
  // ?competition=<id> URL contract, so same-model provider versions remain
  // distinct without client-only state.
  it("addresses every competition by id in the search selector", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition());
    await storage.putCompetition(defaultCompetition({ id: "comp-other", model: "anthropic/claude-opus-5" }));

    const html = renderToStaticMarkup(
      await CompetitionPage.default({ searchParams: Promise.resolve({ competition: "comp-other" }) }),
    );

    expect(html).toContain('form role="search"');
    expect(html).toContain('name="competition"');
    expect(html).toContain(`value="${encodeURIComponent("comp-other")}"`);
    expect(html).toContain(`value="${encodeURIComponent(defaultCompetitionId())}"`);
  });

  it("marks the requested competition selected in the native selector", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition());
    await storage.putCompetition(defaultCompetition({ id: "comp-other", model: "anthropic/claude-opus-5" }));

    const html = renderToStaticMarkup(
      await CompetitionPage.default({ searchParams: Promise.resolve({ competition: "comp-other" }) }),
    );

    expect(html).toMatch(/<option value="comp-other" selected="">/);
    expect(html).not.toMatch(
      new RegExp(`<option value="${defaultCompetitionId()}" selected="">`),
    );
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

  // The baseline is the bar. Entries that clear it are ranked; entries that do
  // not are shown separately and unranked, so nobody appears to be "winning"
  // while scoring worse than the unaided harness.
  it("splits the board at the baseline and labels the baseline row", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition());
    await storage.putSubmission(submission("base", { run_id: "r-base", competition_baseline: true }));
    await storage.putRun(run("r-base", { submission_id: "base", tasks_passed: 7, total_cost_usd: 1 }));
    await storage.putSubmission(submission("winner", { run_id: "r-win", github_login: "beat-it" }));
    await storage.putRun(run("r-win", { submission_id: "winner", tasks_passed: 11, total_cost_usd: 1 }));
    await storage.putSubmission(submission("loser", { run_id: "r-lose", github_login: "missed-it" }));
    await storage.putRun(run("r-lose", { submission_id: "loser", tasks_passed: 3, total_cost_usd: 1 }));

    const html = renderToStaticMarkup(await CompetitionPage.default());

    // The baseline row carries a label, not a login — it has no submitter.
    expect(html).toContain(">Baseline<");
    expect(html).toContain("Below the baseline");

    // Split on the heading and check membership per section. React emits a
    // <link rel="preload"> avatar tag for BOTH entrants at the top of the
    // document, so those have to come off first or every entrant looks like
    // it appears in the ranked half.
    const body = html.replace(/<link rel="preload"[^>]*>/g, "");
    const [rankedSection, belowSection] = body.split("Below the baseline");
    expect(rankedSection).toContain("beat-it");
    expect(rankedSection).not.toContain("missed-it");
    expect(belowSection).toContain("missed-it");
    expect(belowSection).not.toContain("beat-it");
  });

  it("shows no below-baseline table when every entry cleared the bar", async () => {
    mockAuth.mockResolvedValue(null);
    const storage = resetStorage();
    await storage.putCompetition(defaultCompetition());
    await storage.putSubmission(submission("base", { run_id: "r-base", competition_baseline: true }));
    await storage.putRun(run("r-base", { submission_id: "base", tasks_passed: 7, total_cost_usd: 1 }));
    await storage.putSubmission(submission("winner", { run_id: "r-win", github_login: "beat-it" }));
    await storage.putRun(run("r-win", { submission_id: "winner", tasks_passed: 11, total_cost_usd: 1 }));

    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).not.toContain("Below the baseline");
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
