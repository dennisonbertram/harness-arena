// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { CompetitionRow } from "@/lib/competition-leaderboard";
import type { ScatterItem } from "./ScatterChart";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { CompetitionLeaderboardWithChart } from "./CompetitionLeaderboardWithChart";

const rankedRow: CompetitionRow = {
  submissionId: "submission-ranked",
  runId: "run-ranked",
  rank: 1,
  tied: false,
  tasksPassed: 12,
  totalTasks: 16,
  totalCostUsd: 1.0912,
  submittedAt: "2026-07-31T00:00:00.000Z",
  githubLogin: "octocat",
};

const baselineRow: CompetitionRow = {
  ...rankedRow,
  submissionId: "submission-baseline",
  runId: "run-baseline",
  tasksPassed: 9,
  totalCostUsd: 2.2982,
  githubLogin: "unknown",
};

const scatterItems: ScatterItem[] = [
  {
    runId: rankedRow.runId,
    cx: 42,
    cy: 76,
    githubLogin: rankedRow.githubLogin,
    model: "thinkingmachines/inkling-small",
    tasksPassed: rankedRow.tasksPassed,
    totalTasks: rankedRow.totalTasks,
    totalCostUsd: rankedRow.totalCostUsd,
    isBaseline: false,
  },
  {
    runId: baselineRow.runId,
    cx: 190,
    cy: 34,
    githubLogin: baselineRow.githubLogin,
    model: "thinkingmachines/inkling-small",
    tasksPassed: baselineRow.tasksPassed,
    totalTasks: baselineRow.totalTasks,
    totalCostUsd: baselineRow.totalCostUsd,
    isBaseline: true,
  },
];

function renderLinkedLeaderboard() {
  return render(
    <CompetitionLeaderboardWithChart
      scatterItems={scatterItems}
      scatterScale={{ width: 240, height: 140, padding: 20, xMax: 3, yMax: 16 }}
      chartModel="thinkingmachines/inkling-small"
      ranked={[rankedRow]}
      belowBaseline={[]}
      baselineRow={baselineRow}
      baselineModel="thinkingmachines/inkling-small"
      baselineState="ready"
      currentGithubLogin={undefined}
    />,
  );
}

afterEach(cleanup);

describe("CompetitionLeaderboardWithChart", () => {
  it("highlights a chart point when its leaderboard row is hovered", () => {
    const { container } = renderLinkedLeaderboard();

    fireEvent.mouseEnter(container.querySelector('tr[data-row-kind="ranked"]')!);

    expect(container.querySelector('[data-chart-point-run-id="run-ranked"]')).toHaveAttribute("data-linked-hover", "true");
  });

  it("highlights a chart point when its leaderboard row receives a pointer", () => {
    const { container } = renderLinkedLeaderboard();

    fireEvent.pointerEnter(container.querySelector('tr[data-row-kind="ranked"]')!);

    expect(container.querySelector('[data-chart-point-run-id="run-ranked"]')).toHaveAttribute("data-linked-hover", "true");
  });

  it("highlights a leaderboard row when its chart point is hovered", () => {
    const { container } = renderLinkedLeaderboard();

    fireEvent.mouseEnter(container.querySelector('[data-chart-hit-area="run-ranked"]')!);

    expect(container.querySelector('tr[data-row-kind="ranked"]')).toHaveAttribute("data-linked-hover", "true");
  });
});
