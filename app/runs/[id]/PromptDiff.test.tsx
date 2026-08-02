// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromptDiff } from "./PromptDiff";

afterEach(() => {
  cleanup();
});

const BASELINE = "one\ntwo\nthree";
// two dels (two, three) paired against three adds (TWO, THREE, four) — the
// mismatched counts exercise the "no counterpart on this side" (null cell)
// branch of the split view as well as add/del/same.
const SUBMITTED = "one\nTWO\nTHREE\nfour";

describe("PromptDiff", () => {
  it("shows the no-custom-prompt message and no diff UI when the submitted prompt is blank", () => {
    render(<PromptDiff baseline={BASELINE} submitted="   " />);

    expect(screen.getByText(/This run used no custom system prompt/)).toBeInTheDocument();
    expect(screen.queryByText(/vs the vanilla baseline/)).not.toBeInTheDocument();
  });

  it("renders the +added/-removed summary and defaults to the split (side-by-side) view", () => {
    render(<PromptDiff baseline={BASELINE} submitted={SUBMITTED} />);

    expect(screen.getByText("+3")).toBeInTheDocument();
    expect(screen.getByText("−2")).toBeInTheDocument();
    expect(screen.getByText("vs the vanilla baseline")).toBeInTheDocument();

    const sideBySideButton = screen.getByRole("button", { name: "Side by side" });
    expect(sideBySideButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("columnheader", { name: "Vanilla baseline" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "This run's prompt" })).toBeInTheDocument();

    // "one" is unchanged (same), so it renders on BOTH sides of that row.
    // "two"/"three" only on the baseline side (del), "TWO"/"THREE"/"four"
    // only on the submitted side (add) — and the mismatched del/add counts
    // leave one row with a blank cell on one side (the null-cell branch).
    expect(screen.getAllByText("one")).toHaveLength(2);
    expect(screen.getByText("two")).toBeInTheDocument();
    expect(screen.getByText("TWO")).toBeInTheDocument();
    expect(screen.getByText("four")).toBeInTheDocument();
  });

  it("switches to the unified view, prefixing added/removed/unchanged lines", async () => {
    const user = userEvent.setup();
    render(<PromptDiff baseline={BASELINE} submitted={SUBMITTED} />);

    await user.click(screen.getByRole("button", { name: "Unified" }));

    expect(screen.getByRole("button", { name: "Unified" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Side by side" })).toHaveAttribute("aria-pressed", "false");
    // Split-only table headers are gone once unified is active.
    expect(screen.queryByRole("columnheader", { name: "Vanilla baseline" })).not.toBeInTheDocument();

    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("two")).toBeInTheDocument();
    expect(screen.getByText("four")).toBeInTheDocument();
  });

  it("treats an unchanged prompt (identical to baseline) as a zero-line diff, not blank-prompt copy", () => {
    render(<PromptDiff baseline={BASELINE} submitted={BASELINE} />);

    expect(screen.getByText("+0")).toBeInTheDocument();
    expect(screen.getByText("−0")).toBeInTheDocument();
    expect(screen.queryByText(/This run used no custom system prompt/)).not.toBeInTheDocument();
  });
});
