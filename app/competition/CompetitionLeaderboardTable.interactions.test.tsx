// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

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

beforeEach(() => {
  push.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("CompetitionLeaderboardTable interactions", () => {
  it("navigates straight to an entrant's run when its row is clicked", async () => {
    const user = userEvent.setup();
    render(
      <CompetitionLeaderboardTable
        ranked={[row({ submissionId: "a", githubLogin: "octocat", runId: "run-a" })]}
        currentGithubLogin={undefined}
      />,
    );

    await user.click(screen.getByRole("row", { name: /octocat/ }));

    expect(push).toHaveBeenCalledWith("/runs/run-a");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("navigates straight to the baseline run when its row is clicked", async () => {
    const user = userEvent.setup();
    render(
      <CompetitionLeaderboardTable
        ranked={[]}
        baselineRow={row({ submissionId: "baseline", runId: "baseline-run", githubLogin: "unknown" })}
        currentGithubLogin={undefined}
      />,
    );

    await user.click(screen.getByRole("row", { name: /baseline/i }));

    expect(push).toHaveBeenCalledWith("/runs/baseline-run");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("navigates on Enter or Space and prevents Space from scrolling", () => {
    render(<CompetitionLeaderboardTable ranked={[row({ runId: "keyboard-run" })]} currentGithubLogin={undefined} />);
    const entry = screen.getByRole("row", { name: /octocat/ });

    fireEvent.keyDown(entry, { key: "Enter" });
    const notCancelled = fireEvent.keyDown(entry, { key: " " });

    expect(push).toHaveBeenNthCalledWith(1, "/runs/keyboard-run");
    expect(push).toHaveBeenNthCalledWith(2, "/runs/keyboard-run");
    expect(notCancelled).toBe(false);
  });

  it("does not navigate for an unrelated key", () => {
    render(<CompetitionLeaderboardTable ranked={[row()]} currentGithubLogin={undefined} />);

    fireEvent.keyDown(screen.getByRole("row", { name: /octocat/ }), { key: "a" });

    expect(push).not.toHaveBeenCalled();
  });
});
