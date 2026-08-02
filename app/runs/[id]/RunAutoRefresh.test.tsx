// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { RunAutoRefresh } from "./RunAutoRefresh";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RunAutoRefresh", () => {
  it("renders nothing", () => {
    const { container } = render(<RunAutoRefresh status="running" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("polls router.refresh() every 15s while the run is running", () => {
    render(<RunAutoRefresh status="running" />);

    expect(refresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(15_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(15_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("polls while queued too", () => {
    render(<RunAutoRefresh status="queued" />);

    vi.advanceTimersByTime(15_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not poll for a terminal status", () => {
    render(<RunAutoRefresh status="completed" />);

    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("clears the interval on unmount, so no refresh fires after the component is gone", () => {
    const { unmount } = render(<RunAutoRefresh status="running" />);
    unmount();

    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stops polling once the status prop transitions to terminal", () => {
    const { rerender } = render(<RunAutoRefresh status="running" />);
    rerender(<RunAutoRefresh status="completed" />);

    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
