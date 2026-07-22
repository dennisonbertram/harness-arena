import { describe, expect, it } from "vitest";
import { formatDuration, formatUsd, scaleScatterPoints } from "./format";

describe("formatUsd", () => {
  it("formats zero with 4 decimal places", () => {
    expect(formatUsd(0)).toBe("$0.0000");
  });

  it("formats a sub-dollar amount with 4 decimal places", () => {
    expect(formatUsd(1.5)).toBe("$1.5000");
  });

  it("formats a large amount with thousands separators and 4 decimal places", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.5000");
  });
});

describe("formatDuration", () => {
  it("formats sub-minute durations as seconds with one decimal", () => {
    expect(formatDuration(5)).toBe("5.0s");
  });

  it("formats zero seconds", () => {
    expect(formatDuration(0)).toBe("0.0s");
  });

  it("formats durations over a minute as minutes and whole seconds", () => {
    expect(formatDuration(65)).toBe("1m 5s");
  });

  it("rounds fractional seconds when over a minute", () => {
    expect(formatDuration(125.4)).toBe("2m 5s");
  });
});

describe("scaleScatterPoints", () => {
  const opts = { width: 640, height: 320, padding: 40 };

  it("returns no points for an empty run list without throwing", () => {
    const result = scaleScatterPoints([], opts);

    expect(result.points).toEqual([]);
  });

  it("places a single run's point within the plot bounds", () => {
    const result = scaleScatterPoints(
      [{ runId: "run-1", totalCostUsd: 2, tasksPassed: 10 }],
      opts,
    );

    expect(result.points).toHaveLength(1);
    const [point] = result.points;
    expect(point.cx).toBeGreaterThanOrEqual(opts.padding);
    expect(point.cx).toBeLessThanOrEqual(opts.width - opts.padding);
    // tasksPassed=10 is the max of the fixed 0-10 y-scale, so it sits at the top (smallest cy).
    expect(point.cy).toBeCloseTo(opts.padding, 5);
  });

  it("does not divide by zero when every run has zero cost", () => {
    const result = scaleScatterPoints(
      [{ runId: "run-1", totalCostUsd: 0, tasksPassed: 3 }],
      opts,
    );

    const [point] = result.points;
    expect(Number.isFinite(point.cx)).toBe(true);
    expect(Number.isFinite(point.cy)).toBe(true);
    expect(point.cx).toBeCloseTo(opts.padding, 5);
  });

  it("maps tasksPassed=0 to the bottom of the fixed 0-10 y-scale", () => {
    const result = scaleScatterPoints(
      [{ runId: "run-1", totalCostUsd: 1, tasksPassed: 0 }],
      opts,
    );

    const [point] = result.points;
    expect(point.cy).toBeCloseTo(opts.height - opts.padding, 5);
  });
});
