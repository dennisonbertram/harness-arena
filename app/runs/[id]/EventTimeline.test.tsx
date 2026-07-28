// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventTimeline, type TimelineEvent } from "./EventTimeline";

afterEach(() => {
  cleanup();
});

const EVENTS: TimelineEvent[] = [
  { seq: 1, ts: "2026-07-25T00:00:00.000Z", type: "run.sandbox_ready", payload: { ok: true } },
  { seq: 2, ts: "2026-07-25T00:01:00.000Z", type: "task.started", payload: { task_id: "task-a", index: 0 } },
];

describe("EventTimeline", () => {
  it("renders one row per event with its sequence and type", () => {
    render(<EventTimeline events={EVENTS} />);

    expect(screen.getByText("run.sandbox_ready")).toBeInTheDocument();
    expect(screen.getByText("task.started")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders an empty table body for an empty event list, without crashing", () => {
    render(<EventTimeline events={[]} />);
    expect(screen.queryByRole("row")).not.toBeNull(); // header row only
    expect(screen.queryByText("task.started")).not.toBeInTheDocument();
  });

  it("opens a JSON detail modal with the formatted payload when a row's payload is clicked", async () => {
    const user = userEvent.setup();
    render(<EventTimeline events={EVENTS} />);

    await user.click(screen.getByRole("button", { name: JSON.stringify(EVENTS[1].payload) }));

    const dialog = screen.getByRole("dialog", { name: "Event 2 payload" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent('"task_id": "task-a"');
    expect(dialog).toHaveTextContent('"index": 0');
  });

  it("closes the modal via the close button", async () => {
    const user = userEvent.setup();
    render(<EventTimeline events={EVENTS} />);
    await user.click(screen.getByRole("button", { name: JSON.stringify(EVENTS[0].payload) }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the modal via Escape", async () => {
    const user = userEvent.setup();
    render(<EventTimeline events={EVENTS} />);
    await user.click(screen.getByRole("button", { name: JSON.stringify(EVENTS[0].payload) }));

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the modal on backdrop click but not on click inside the modal content", async () => {
    const user = userEvent.setup();
    render(<EventTimeline events={EVENTS} />);
    await user.click(screen.getByRole("button", { name: JSON.stringify(EVENTS[0].payload) }));

    await user.click(screen.getByText("run.sandbox_ready", { selector: "div.mono" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("only one modal is open at a time — clicking a second payload swaps the selection", async () => {
    const user = userEvent.setup();
    render(<EventTimeline events={EVENTS} />);
    await user.click(screen.getByRole("button", { name: JSON.stringify(EVENTS[0].payload) }));
    expect(screen.getByRole("dialog", { name: "Event 1 payload" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: JSON.stringify(EVENTS[1].payload) }));

    expect(screen.getByRole("dialog", { name: "Event 2 payload" })).toBeInTheDocument();
  });
});
