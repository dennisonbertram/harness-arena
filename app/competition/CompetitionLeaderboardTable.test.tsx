import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompetitionLeaderboardTable } from "./CompetitionLeaderboardTable";
import type { CompetitionRow } from "@/lib/competition-leaderboard";

function row(overrides: Partial<CompetitionRow> = {}): CompetitionRow {
  return {
    submissionId: `s-${Math.random()}`,
    runId: "r-1",
    rank: 1,
    tied: false,
    tasksPassed: 10,
    totalTasks: 16,
    totalCostUsd: 1.2345,
    submittedAt: "2026-07-25T00:00:00.000Z",
    githubLogin: "octocat",
    ...overrides,
  };
}

describe("CompetitionLeaderboardTable", () => {
  it("renders a real login's avatar with the GitHub-hosted URL and its login as alt text", () => {
    const html = renderToStaticMarkup(
      <CompetitionLeaderboardTable ranked={[row({ githubLogin: "octocat" })]} currentGithubLogin={undefined} />,
    );

    expect(html).toContain('src="https://github.com/octocat.png"');
    expect(html).toContain('alt="octocat"');
  });

  it("renders a placeholder glyph, not a real avatar request, for the 'unknown' fallback login", () => {
    const html = renderToStaticMarkup(
      <CompetitionLeaderboardTable ranked={[row({ githubLogin: "unknown" })]} currentGithubLogin={undefined} />,
    );

    expect(html).not.toContain("https://github.com/unknown.png");
    expect(html).toContain(">?<");
  });

  it("marks every row tied for rank 1 with the crown marker, and no other rank", () => {
    const html = renderToStaticMarkup(
      <CompetitionLeaderboardTable
        ranked={[
          row({ submissionId: "a", rank: 1, tied: true }),
          row({ submissionId: "b", rank: 1, tied: true }),
          row({ submissionId: "c", rank: 3, tied: false }),
        ]}
        currentGithubLogin={undefined}
      />,
    );

    expect(html.match(/👑/g) ?? []).toHaveLength(2);
  });

  it("renders tasks-solved as the bold primary metric with cost as a secondary line underneath", () => {
    const html = renderToStaticMarkup(
      <CompetitionLeaderboardTable
        ranked={[row({ tasksPassed: 12, totalTasks: 16, totalCostUsd: 3.5 })]}
        currentGithubLogin={undefined}
      />,
    );

    expect(html).toContain("12/16");
    expect(html).toContain("$3.5000");
    // The primary metric's cell appears before the secondary cost line in source order.
    expect(html.indexOf("12/16")).toBeLessThan(html.indexOf("$3.5000"));
  });

  it("highlights the row matching currentGithubLogin and no others", () => {
    const html = renderToStaticMarkup(
      <CompetitionLeaderboardTable
        ranked={[row({ submissionId: "mine", githubLogin: "octocat" }), row({ submissionId: "theirs", githubLogin: "hubot" })]}
        currentGithubLogin="octocat"
      />,
    );

    // Exactly one row (of the two rendered) carries the highlight -- not zero, not both.
    expect(html.match(/var\(--blue-100\)/g) ?? []).toHaveLength(1);
  });

  it("applies no highlight when currentGithubLogin is undefined or matches no row", () => {
    const signedOut = renderToStaticMarkup(
      <CompetitionLeaderboardTable ranked={[row({ githubLogin: "octocat" })]} currentGithubLogin={undefined} />,
    );
    const noMatch = renderToStaticMarkup(
      <CompetitionLeaderboardTable ranked={[row({ githubLogin: "octocat" })]} currentGithubLogin="someone-else" />,
    );

    expect(signedOut).not.toContain("var(--blue-100)");
    expect(noMatch).not.toContain("var(--blue-100)");
  });

  it("preserves the 'Tied for #N' label for a tied row", () => {
    const html = renderToStaticMarkup(
      <CompetitionLeaderboardTable ranked={[row({ rank: 2, tied: true })]} currentGithubLogin={undefined} />,
    );

    expect(html).toContain("Tied for #2");
  });

  it("initial (closed) markup has a focusable row but no open dialog", () => {
    const html = renderToStaticMarkup(
      <CompetitionLeaderboardTable ranked={[row()]} currentGithubLogin={undefined} />,
    );

    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain('role="dialog"');
  });
});
