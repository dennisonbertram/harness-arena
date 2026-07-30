// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskModelPerformanceChart } from "./TaskModelPerformanceChart";

describe("TaskModelPerformanceChart", () => {
  it("compares pass rate, turns, and measured wall-clock time per model", () => {
    const { container } = render(
      <TaskModelPerformanceChart
        models={[
          {
            model: "zai/glm-5.2",
            attempts: 4,
            passed: 3,
            passRate: 0.75,
            meanTurns: 2.5,
            meanDurationS: 42.5,
            outputTokensPerSecond: 12.5,
            meanCostUsd: null,
          },
          {
            model: "anthropic/claude-sonnet-5",
            attempts: 2,
            passed: 1,
            passRate: 0.5,
            meanTurns: 6,
            meanDurationS: null,
            outputTokensPerSecond: null,
            meanCostUsd: null,
          },
        ]}
      />,
    );

    expect(screen.getByRole("img", { name: /performance by model/i })).toBeInTheDocument();
    expect(screen.getByText("Pass rate")).toBeInTheDocument();
    expect(screen.getByText("Mean turns")).toBeInTheDocument();
    expect(screen.getByText("Mean wall time")).toBeInTheDocument();
    expect(screen.getByText("Output tok/s")).toBeInTheDocument();
    expect(screen.getByText("75% (3/4)")).toBeInTheDocument();
    expect(screen.getByText("42.5s")).toBeInTheDocument();
    expect(screen.getByText("12.5 tok/s")).toBeInTheDocument();
    expect(screen.getAllByText("unmeasured")).toHaveLength(2);
    expect(container.querySelector('[data-metric="pass-rate"][data-model="zai/glm-5.2"]')).toHaveStyle({ width: "75%" });
    expect(container.querySelector('[data-metric="duration"][data-model="anthropic/claude-sonnet-5"]')).toBeNull();
  });
});
