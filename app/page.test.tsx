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
});
