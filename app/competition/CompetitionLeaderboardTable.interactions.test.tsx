// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

afterEach(() => {
  cleanup();
});

describe("CompetitionLeaderboardTable interactions", () => {
  it("opens the entry detail dialog for that row when a row is clicked, and moves focus to its close button", async () => {
    const user = userEvent.setup();
    render(
      <CompetitionLeaderboardTable
        ranked={[row({ submissionId: "a", githubLogin: "octocat", runId: "run-a" })]}
        currentGithubLogin={undefined}
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("row", { name: /octocat/ }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("octocat");
    expect(screen.getByRole("link", { name: /View full run/ })).toHaveAttribute("href", "/runs/run-a");
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("opens the dialog for the correct row when multiple rows are present", async () => {
    const user = userEvent.setup();
    render(
      <CompetitionLeaderboardTable
        ranked={[
          row({ submissionId: "a", githubLogin: "octocat" }),
          row({ submissionId: "b", githubLogin: "hubot" }),
        ]}
        currentGithubLogin={undefined}
      />,
    );

    await user.click(screen.getByRole("row", { name: /hubot/ }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("hubot");
    expect(dialog).not.toHaveTextContent("octocat");
  });

  // These three use fireEvent.keyDown rather than userEvent.keyboard: this
  // <tr> is focusable only via an explicit tabIndex (not a native
  // interactive element), and userEvent's raw dispatch to it doesn't route
  // through React's synthetic event delegation under this
  // React 19 + jsdom + user-event combination (confirmed by comparing
  // against a native-listener probe -- the DOM event fires and bubbles,
  // but React's handler isn't invoked). fireEvent.keyDown goes through
  // Testing Library's React act()-wrapped dispatch and does reach it, which
  // is what the click- and Escape-driven tests above already prove works
  // for this same handler wiring.
  it("opens the dialog when Enter is pressed on a focused row", () => {
    render(<CompetitionLeaderboardTable ranked={[row({ githubLogin: "octocat" })]} currentGithubLogin={undefined} />);

    fireEvent.keyDown(screen.getByRole("row", { name: /octocat/ }), { key: "Enter" });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens the dialog when Space is pressed on a focused row, and prevents the page-scroll default", () => {
    render(<CompetitionLeaderboardTable ranked={[row({ githubLogin: "octocat" })]} currentGithubLogin={undefined} />);

    // fireEvent's keyDown helper returns the raw dispatchEvent() result,
    // which is false when the handler called preventDefault().
    const notCancelled = fireEvent.keyDown(screen.getByRole("row", { name: /octocat/ }), { key: " " });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(notCancelled).toBe(false);
  });

  it("does not open the dialog for an unrelated key", () => {
    render(<CompetitionLeaderboardTable ranked={[row({ githubLogin: "octocat" })]} currentGithubLogin={undefined} />);

    fireEvent.keyDown(screen.getByRole("row", { name: /octocat/ }), { key: "a" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the row that opened it", async () => {
    const user = userEvent.setup();
    render(<CompetitionLeaderboardTable ranked={[row({ githubLogin: "octocat" })]} currentGithubLogin={undefined} />);

    const triggerRow = screen.getByRole("row", { name: /octocat/ });
    await user.click(triggerRow);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(triggerRow).toHaveFocus();
  });

  it("ignores a non-Escape key while the dialog is open", async () => {
    const user = userEvent.setup();
    render(<CompetitionLeaderboardTable ranked={[row({ githubLogin: "octocat" })]} currentGithubLogin={undefined} />);

    await user.click(screen.getByRole("row", { name: /octocat/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await user.keyboard("x");

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes when the backdrop is clicked directly, and returns focus to the triggering row", async () => {
    const user = userEvent.setup();
    render(<CompetitionLeaderboardTable ranked={[row({ githubLogin: "octocat" })]} currentGithubLogin={undefined} />);

    const triggerRow = screen.getByRole("row", { name: /octocat/ });
    await user.click(triggerRow);
    const dialog = await screen.findByRole("dialog");

    // Click the backdrop itself, not the inner card -- this is the element
    // the closeModal onClick handler lives on.
    await user.click(dialog);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(triggerRow).toHaveFocus();
  });

  it("does not close when a click inside the dialog card is stopped from propagating to the backdrop", async () => {
    const user = userEvent.setup();
    render(<CompetitionLeaderboardTable ranked={[row({ githubLogin: "octocat" })]} currentGithubLogin={undefined} />);

    await user.click(screen.getByRole("row", { name: /octocat/ }));
    await screen.findByRole("dialog");

    // The heading is inside the inner card, whose onClick calls
    // stopPropagation so the backdrop's closeModal handler never fires.
    await user.click(screen.getByRole("heading", { name: "octocat" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes via the explicit Close button", async () => {
    const user = userEvent.setup();
    render(<CompetitionLeaderboardTable ranked={[row({ githubLogin: "octocat" })]} currentGithubLogin={undefined} />);

    const triggerRow = screen.getByRole("row", { name: /octocat/ });
    await user.click(triggerRow);
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(triggerRow).toHaveFocus();
  });
});
