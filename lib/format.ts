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
}

export interface ScatterPoint extends ScatterInput {
  cx: number;
  cy: number;
}

export interface ScatterScaleOptions {
  width: number;
  height: number;
  padding: number;
}

export interface ScatterScale {
  points: ScatterPoint[];
  xMax: number;
  yMax: number;
  width: number;
  height: number;
  padding: number;
}

const DEFAULT_SCALE_OPTIONS: ScatterScaleOptions = { width: 640, height: 320, padding: 40 };

// Fixed 0-10 scale for tasks_passed — the harness always runs the same 10
// tasks, so the y-axis range doesn't depend on the data.
const Y_MAX = 10;

/**
 * Maps (totalCostUsd, tasksPassed) pairs to SVG coordinates for a scatter
 * chart. x is linear over [0, xMax] where xMax is the highest cost among the
 * given runs (guarded against 0 so an all-zero-cost dataset doesn't divide by
 * zero). y is linear over the fixed [0, 10] tasks-passed range, inverted
 * because SVG y grows downward.
 */
export function scaleScatterPoints(
  runs: ScatterInput[],
  options: ScatterScaleOptions = DEFAULT_SCALE_OPTIONS,
): ScatterScale {
  const { width, height, padding } = options;
  const highestCost = runs.reduce((max, run) => Math.max(max, run.totalCostUsd), 0);
  const xMax = highestCost > 0 ? highestCost : 1;
  const plotWidth = width - 2 * padding;
  const plotHeight = height - 2 * padding;

  const points: ScatterPoint[] = runs.map((run) => ({
    ...run,
    cx: padding + (run.totalCostUsd / xMax) * plotWidth,
    cy: height - padding - (run.tasksPassed / Y_MAX) * plotHeight,
  }));

  return { points, xMax, yMax: Y_MAX, width, height, padding };
}
