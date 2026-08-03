import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
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
    billedCostUsd: 1.2345,
    pricingVersion: "inkling-small-2026-08-03-v1",
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

    expect(html).toContain("https://github.com/octocat.png");
    expect(html).toContain('alt="octocat"');
  });

  it("separates normalized scoring cost from actual billed spend and cost per solved task", () => {
    const html = renderToStaticMarkup(
      <CompetitionLeaderboardTable
        ranked={[row({ tasksPassed: 12, totalCostUsd: 1.0912, billedCostUsd: 3.5 })]}
        belowBaseline={[row({ submissionId: "zero", tasksPassed: 0, totalCostUsd: 0 })]}
        baselineRow={row({ submissionId: "baseline", tasksPassed: 9, totalCostUsd: 2.2982 })}
        currentGithubLogin={undefined}
      />,
    );

    expect(html).toMatch(/<th[^>]*>Normalized run cost<\/th>/);
    expect(html).toMatch(/<th[^>]*>Cost \/ solved task<\/th>/);
    expect(html).toContain("$1.0912");
    expect(html).toContain("billed $3.5000");
    expect(html).toContain("$0.0909");
    expect(html).toContain("$2.2982");
    expect(html).toContain("$0.2554");
    expect(html).toMatch(/data-cost-per-solved-task="true"[^>]*>[\s\S]*>—<\/span><\/td>/);
  });

  it("shows cost efficiency direction and percentage against the baseline", () => {
    const html = renderToStaticMarkup(
      <CompetitionLeaderboardTable
        ranked={[
          row({ submissionId: "cheaper", tasksPassed: 12, totalCostUsd: 1.0912 }),
          row({ submissionId: "pricier", rank: 2, tasksPassed: 6, totalCostUsd: 3 }),
        ]}
        baselineRow={row({ submissionId: "baseline", tasksPassed: 9, totalCostUsd: 2.2982 })}
        currentGithubLogin={undefined}
      />,
    );

    expect(html).toContain('aria-label="Cost per solved task is 64% lower than baseline"');
    expect(html).toContain(">↓ 64%</span>");
    expect(html).toContain('aria-label="Cost per solved task is 96% higher than baseline"');
    expect(html).toContain(">↑ 96%</span>");
    expect(html).not.toContain('aria-label="Cost per solved task is 0%');
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

  it("renders tasks solved and total cost as separate metrics", () => {
    const html = renderToStaticMarkup(
      <CompetitionLeaderboardTable
        ranked={[row({ tasksPassed: 12, totalTasks: 16, totalCostUsd: 3.5 })]}
        currentGithubLogin={undefined}
      />,
    );

    expect(html).toContain("12/16");
    expect(html).toContain("$3.5000");
    expect(html).toContain("Normalized run cost");
    expect(html).toContain("Cost / solved task");
    // The task count appears before the total cost column in source order.
    expect(html.indexOf("12/16")).toBeLessThan(html.indexOf("$3.5000"));
  });

  it("shows ranked task-score gains versus the baseline and the next row", () => {
    const html = renderToStaticMarkup(
      <CompetitionLeaderboardTable
        ranked={[
          row({ submissionId: "winner", rank: 1, tasksPassed: 12 }),
          row({ submissionId: "runner-up", rank: 2, tasksPassed: 9 }),
        ]}
        baselineRow={row({ submissionId: "baseline", tasksPassed: 9 })}
        currentGithubLogin={undefined}
      />,
    );

    expect(html).toContain(">+33%</span>");
    expect(html).not.toContain("+33% vs #2");
    expect(html).not.toContain("+33% vs baseline");
    expect(html).toContain(">0%</span>");
  });

  it("renders baseline and next comparisons as dedicated table columns", () => {
    const html = renderToStaticMarkup(
      <CompetitionLeaderboardTable
        ranked={[row({ tasksPassed: 12 }), row({ submissionId: "runner-up", rank: 2, tasksPassed: 9 })]}
        baselineRow={row({ submissionId: "baseline", tasksPassed: 9 })}
        currentGithubLogin={undefined}
      />,
    );

    expect(html).toMatch(/<th[^>]*>vs baseline<\/th>/);
    expect(html).toMatch(/<th[^>]*>vs next<\/th>/);
    expect(html).toContain(">Baseline</span>");
    expect(html).not.toContain("bar to beat");
    expect(html).not.toMatch(/<td[^>]*>[^<]*12\/16[\s\S]*data-comparison=/);
  });

  it("uses the baseline background without an extra top border", () => {
    const html = renderToStaticMarkup(
      <CompetitionLeaderboardTable
        ranked={[]}
        baselineRow={row({ submissionId: "baseline" })}
        currentGithubLogin={undefined}
      />,
    );

    expect(html).toMatch(/data-row-kind="baseline"[^>]*background:var\(--blue-100\)/);
    expect(html).not.toContain("border-top:2px solid var(--blue-700)");
  });

  it("shows below-baseline task-score losses and handles zero-task references without infinity", () => {
    const html = renderToStaticMarkup(
      <CompetitionLeaderboardTable
        ranked={[]}
        belowBaseline={[
          row({ submissionId: "close", tasksPassed: 8 }),
          row({ submissionId: "zero-a", tasksPassed: 0 }),
          row({ submissionId: "zero-b", tasksPassed: 0 }),
        ]}
        baselineRow={row({ submissionId: "baseline", tasksPassed: 9 })}
        currentGithubLogin={undefined}
      />,
    );

    expect(html).toContain(">-11%</span>");
    expect(html).toContain(">8 tasks more</span>");
    expect(html).not.toContain("Infinity");
    expect(html).toContain(">0%</span>");
  });

  it("reserves the blue background for the baseline even when every entry belongs to the current user", () => {
    const html = renderToStaticMarkup(
      <CompetitionLeaderboardTable
        ranked={[
          row({ submissionId: "mine-one", githubLogin: "octocat" }),
          row({ submissionId: "mine-two", githubLogin: "octocat" }),
        ]}
        belowBaseline={[row({ submissionId: "mine-three", githubLogin: "octocat" })]}
        baselineRow={row({ submissionId: "baseline" })}
        currentGithubLogin="octocat"
      />,
    );

    expect(html).toMatch(/data-row-kind="baseline"[^>]*background:var\(--blue-100\)/);
    expect(html.match(/var\(--blue-100\)/g) ?? []).toHaveLength(1);
  });

  it("does not apply a background when currentGithubLogin is undefined or matches no row", () => {
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
