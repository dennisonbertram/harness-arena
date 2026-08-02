// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScatterChart, type ScatterItem } from "./ScatterChart";

const normal: ScatterItem = {
  runId: "run-normal",
  cx: 42,
  cy: 76,
  githubLogin: "octocat",
  model: "zai/glm-5.2",
  tasksPassed: 9,
  totalTasks: 16,
  totalCostUsd: 1.25,
  isBaseline: false,
};

const baseline: ScatterItem = {
  runId: "run-baseline",
  cx: 190,
  cy: 34,
  githubLogin: "ignored-for-baselines",
  model: "anthropic/claude-sonnet-5",
  tasksPassed: 12,
  totalTasks: 16,
  totalCostUsd: 2.5,
  isBaseline: true,
};

function renderChart(items: ScatterItem[] = [normal, baseline]) {
  return render(<ScatterChart items={items} width={240} height={140} padding={20} xMax={3} yMax={16} />);
}

afterEach(cleanup);

describe("ScatterChart", () => {
  it("renders linked normal and baseline points with the chart axes", () => {
    const { container } = renderChart();

    expect(screen.getByRole("img", { name: /total inference cost versus tasks passed/i })).toBeInTheDocument();
    expect(container.querySelector('a[href="/runs/run-normal"]')).toBeInTheDocument();
    expect(container.querySelector('a[href="/runs/run-baseline"]')).toBeInTheDocument();
    expect(container.querySelector('circle[fill="#4f9bf5"]')).toHaveAttribute("r", "5.5");
    expect(container.querySelector('circle[stroke="#e8912a"]')).toHaveAttribute("stroke-dasharray", "2 2");
    expect(screen.getByText("Total inference cost (USD)")).toBeInTheDocument();
    expect(screen.getByText("Tasks passed (of 16)")).toBeInTheDocument();
  });

  it("shows a normal entrant tooltip with a size-capped GitHub avatar", () => {
    const { container } = renderChart();

    fireEvent.mouseEnter(container.querySelector('a[href="/runs/run-normal"] circle')!);

    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByText("glm-5.2 · 9/16 · $1.2500")).toBeInTheDocument();
    expect(container.querySelector("image")).toHaveAttribute("href", "https://github.com/octocat.png?size=32");
    expect(container.querySelector('circle[fill="#4f9bf5"]')).toHaveAttribute("r", "7.5");

    fireEvent.mouseLeave(container.querySelector('a[href="/runs/run-normal"] circle')!);
    expect(screen.queryByText("octocat")).not.toBeInTheDocument();
  });

  it("labels a baseline by model and omits the submitter avatar", () => {
    const { container } = renderChart();

    fireEvent.mouseEnter(container.querySelector('a[href="/runs/run-baseline"] circle')!);

    expect(screen.getByText("Claude Sonnet 5 Baseline")).toBeInTheDocument();
    expect(screen.getByText("Claude Sonnet 5 · 12/16 · $2.5000")).toBeInTheDocument();
    expect(container.querySelector("image")).not.toBeInTheDocument();
    expect(container.querySelector('circle[stroke="#e8912a"]')).toHaveAttribute("r", "8");
  });
});
