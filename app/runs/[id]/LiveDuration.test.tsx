// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveDuration } from "./LiveDuration";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-25T00:06:30.000Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("LiveDuration", () => {
  it("shows fixed completed time plus the active task's wall-clock elapsed time", async () => {
    render(
      <LiveDuration
        fixedDurationS={12}
        activeStartedAtMs={new Date("2026-07-25T00:00:00.000Z").getTime()}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("6m 42s")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText("6m 43s")).toBeInTheDocument();
  });

  it("renders a terminal measured duration without starting an interval", async () => {
    render(<LiveDuration fixedDurationS={40} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText("40.0s")).toBeInTheDocument();
  });
});
