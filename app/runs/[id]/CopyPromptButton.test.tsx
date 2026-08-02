// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CopyPromptButton } from "./CopyPromptButton";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CopyPromptButton", () => {
  it("copies the given text to the clipboard and flips the label to Copied, then back to Copy 1.5s later", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    vi.useFakeTimers();

    render(<CopyPromptButton text="the submitted prompt" />);

    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      // Flush the microtask queue so the `await navigator.clipboard.writeText(...)`
      // inside the click handler resolves before we assert on its effect.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("the submitted prompt");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });
});
