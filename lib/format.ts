const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/** Formats a USD amount with exactly 4 decimal places (e.g. "$1,234.5000"). */
export function formatUsd(amountUsd: number): string {
  return usdFormatter.format(amountUsd);
}

/** Formats seconds as "Xm Ys" once over a minute, otherwise "X.Ys". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${minutes}m ${secs}s`;
}

export interface ScatterInput {
  runId: string;
  totalCostUsd: number;
  tasksPassed: number;
  model: string; // gateway id — drives the dot color (per-model comparison)
}

export interface ScatterPoint extends ScatterInput {
  cx: number;
  cy: number;
}

export interface ScatterScaleOptions {
  width: number;
  height: number;
  padding: number;
  yMax?: number; // top of the tasks-passed axis (the benchmark's task count)
}

export interface ScatterScale {
  points: ScatterPoint[];
  xMax: number;
  yMax: number;
  width: number;
  height: number;
  padding: number;
}

const DEFAULT_SCALE_OPTIONS: ScatterScaleOptions = { width: 640, height: 320, padding: 40, yMax: 16 };

/**
 * Maps (totalCostUsd, tasksPassed) pairs to SVG coordinates for a scatter
 * chart. x is linear over [0, highest cost among the given runs]; tasksPassed
 * is clamped into [0, 10] before scaling so an out-of-range value (defensive
 * only — the harness always reports 0-10) can't plot past the axis. y is
 * linear over the fixed [0, 10] tasks-passed range, inverted because SVG y
 * grows downward.
 *
 * The returned `xMax` is the real highest cost (which can be 0) — it's for
 * display only. Internally, scaling divides by 1 instead of 0 when every run
 * costs $0, but that fallback never leaks into `xMax` so callers don't show
 * a fabricated "$1.0000" axis label when there's no cost data.
 */
export function scaleScatterPoints(
  runs: ScatterInput[],
  options: ScatterScaleOptions = DEFAULT_SCALE_OPTIONS,
): ScatterScale {
  const { width, height, padding } = options;
  const yMax = options.yMax ?? 16;
  const highestCost = runs.reduce((max, run) => Math.max(max, run.totalCostUsd), 0);
  const xScaleDivisor = highestCost > 0 ? highestCost : 1;
  const plotWidth = width - 2 * padding;
  const plotHeight = height - 2 * padding;

  const points: ScatterPoint[] = runs.map((run) => {
    const clampedTasksPassed = Math.min(yMax, Math.max(0, run.tasksPassed));
    return {
      ...run,
      cx: padding + (run.totalCostUsd / xScaleDivisor) * plotWidth,
      cy: height - padding - (clampedTasksPassed / yMax) * plotHeight,
    };
  });

  return { points, xMax: highestCost, yMax, width, height, padding };
}

/**
 * Fill color for a scatter-chart dot: the leader is highlighted in blue;
 * non-leader dots use gray-900 (~8.45:1 contrast on white) rather than
 * gray-600 (~2.38:1), which falls short of the 3:1 minimum for graphical
 * objects.
 */
export function scatterDotColor(isLeader: boolean): string {
  return isLeader ? "var(--blue-700)" : "var(--gray-900)";
}
