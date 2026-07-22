import { describe, expect, it } from "vitest";
import { formatDuration, formatUsd, scaleScatterPoints, scatterDotColor } from "./format";

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

  describe("regression: zero-cost run must not corrupt the shared x-scale", () => {
    it("keeps a cheaper run to the left of a costlier run even when a third run costs $0", () => {
      // A naive xMax guard (e.g. clamping every cost to at least 1 before
      // scaling, instead of only guarding xMax itself) would wrongly place
      // the $0 run at the same x as a genuinely $1 run. If scaleScatterPoints
      // regresses to that behavior, this test fails.
      const result = scaleScatterPoints(
        [
          { runId: "cheap", totalCostUsd: 1, tasksPassed: 5 },
          { runId: "free", totalCostUsd: 0, tasksPassed: 5 },
          { runId: "expensive", totalCostUsd: 3, tasksPassed: 5 },
        ],
        opts,
      );

      const byId = Object.fromEntries(result.points.map((p) => [p.runId, p]));
      expect(byId.free.cx).toBeLessThan(byId.cheap.cx);
      expect(byId.cheap.cx).toBeLessThan(byId.expensive.cx);
    });
  });

  it("clamps an out-of-range tasksPassed (>10) to the top of the fixed 0-10 y-scale", () => {
    const result = scaleScatterPoints([{ runId: "run-1", totalCostUsd: 1, tasksPassed: 11 }], opts);

    const [point] = result.points;
    expect(point.cy).toBeCloseTo(opts.padding, 5);
  });

  it("returns a real (zero) xMax for display when every run costs $0, instead of a fabricated non-zero value", () => {
    const result = scaleScatterPoints([{ runId: "run-1", totalCostUsd: 0, tasksPassed: 3 }], opts);

    expect(result.xMax).toBe(0);
    expect(Number.isFinite(result.points[0].cx)).toBe(true);
  });

  it("regression: clamping an out-of-range tasksPassed doesn't reintroduce the fabricated xMax when costs are also all $0", () => {
    // Exercises both fixes together: a naive implementation could clamp
    // tasksPassed by mutating the shared scale state in a way that also
    // resets xMax back to the fallback divisor (1) instead of the real (0)
    // max cost.
    const result = scaleScatterPoints([{ runId: "run-1", totalCostUsd: 0, tasksPassed: 15 }], opts);

    expect(result.xMax).toBe(0);
    const [point] = result.points;
    expect(point.cy).toBeCloseTo(opts.padding, 5);
    expect(point.cx).toBeCloseTo(opts.padding, 5);
  });
});

describe("scatterDotColor", () => {
  it("uses gray-900 (not gray-600) for non-leader dots to meet the 3:1 contrast minimum on white", () => {
    expect(scatterDotColor(false)).toBe("var(--gray-900)");
  });

  it("uses blue-700 for the leader dot", () => {
    expect(scatterDotColor(true)).toBe("var(--blue-700)");
  });

  describe("regression: contrast ratio, not just token name", () => {
    // Hex values mirror the light-theme tokens in app/globals.css. Checking
    // the actual contrast math (rather than the literal "var(--gray-900)"
    // string) catches a regression even if a future edit swaps in some
    // other token that still fails the 3:1 minimum.
    const TOKEN_HEX: Record<string, string> = {
      "var(--gray-600)": "#a8a8a8",
      "var(--gray-900)": "#4d4d4d",
      "var(--background-100)": "#ffffff",
    };

    function contrastRatio(hexA: string, hexB: string): number {
      const luminance = (hex: string) => {
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255);
        const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const [lighter, darker] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a);
      return (lighter + 0.05) / (darker + 0.05);
    }

    it("keeps non-leader dots at or above 3:1 contrast against the white background", () => {
      const nonLeaderHex = TOKEN_HEX[scatterDotColor(false)];
      const ratio = contrastRatio(nonLeaderHex, TOKEN_HEX["var(--background-100)"]);
      expect(ratio).toBeGreaterThanOrEqual(3);
      // Sanity check that the old gray-600 value would in fact have failed —
      // proves this test can catch the original bug.
      expect(contrastRatio(TOKEN_HEX["var(--gray-600)"], TOKEN_HEX["var(--background-100)"])).toBeLessThan(3);
    });
  });
});
