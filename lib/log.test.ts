import { describe, expect, it, vi } from "vitest";
import { log } from "./log";

describe("log", () => {
  it("reserved envelope fields (ts, level, event) always win over caller-supplied fields of the same name", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    log("info", "task.started", {
      level: "bogus-level",
      event: "bogus-event",
      ts: "not-a-real-timestamp",
      task_id: "t1",
    });

    const line = spy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line);

    expect(parsed.level).toBe("info");
    expect(parsed.event).toBe("task.started");
    expect(parsed.ts).not.toBe("not-a-real-timestamp");
    expect(() => new Date(parsed.ts).toISOString()).not.toThrow();
    expect(parsed.task_id).toBe("t1");

    spy.mockRestore();
  });
});
