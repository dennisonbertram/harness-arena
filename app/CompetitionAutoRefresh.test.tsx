// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompetitionAutoRefresh } from "./CompetitionAutoRefresh";

const refresh = vi.fn();
const fetchRun = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockClear();
  fetchRun.mockReset();
  vi.stubGlobal("fetch", fetchRun);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CompetitionAutoRefresh", () => {
  it("polls only the pending run and refreshes the board once it becomes terminal", async () => {
    fetchRun.mockResolvedValue({
      ok: true,
      json: async () => ({ status: "completed" }),
    });
    render(<CompetitionAutoRefresh runIds={["run-pending"]} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });

    expect(fetchRun).toHaveBeenCalledWith("/api/runs/run-pending", { cache: "no-store" });
    expect(fetchRun).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh the whole board while the run is still active", async () => {
    fetchRun.mockResolvedValue({
      ok: true,
      json: async () => ({ status: "running" }),
    });
    render(<CompetitionAutoRefresh runIds={["run-pending"]} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(fetchRun).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not start overlapping polls when a run read is slow", async () => {
    fetchRun.mockReturnValue(new Promise(() => {}));
    render(<CompetitionAutoRefresh runIds={["run-pending"]} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });

    expect(fetchRun).toHaveBeenCalledTimes(1);
  });

  it("does not poll while the tab is hidden", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render(<CompetitionAutoRefresh runIds={["run-pending"]} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchRun).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not poll when the board has no pending run ids", async () => {
    render(<CompetitionAutoRefresh runIds={[]} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchRun).not.toHaveBeenCalled();
  });
});
