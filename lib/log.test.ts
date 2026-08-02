import { describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { log, redactLogValue } from "./log";

describe("log", () => {
  it("reserved envelope fields (ts, level, event) always win over caller-supplied fields of the same name", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    log("info", "task.started", {
      level: "bogus-level",
      event: "bogus-event",
      ts: "not-a-real-timestamp",
      task_id: "task-one",
    });

    const line = spy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line);

    expect(parsed.level).toBe("info");
    expect(parsed.event).toBe("task.started");
    expect(parsed.ts).not.toBe("not-a-real-timestamp");
    expect(() => new Date(parsed.ts).toISOString()).not.toThrow();
    expect(parsed.task_id).toBe("task-one");

    spy.mockRestore();
  });
});

describe("observability logger contract", () => {
  it("redacts nested secrets, bearer values, signed URLs, exact configured values, cycles, and Error values", () => {
    const cycle: Record<string, unknown> = { password: "nope" };
    cycle.self = cycle;
    const value = redactLogValue({
      authorization: "Bearer super-secret-token",
      nested: { api_key: "key-value", prompt: "never-log-a-prompt" },
      callback: "https://blob.example/file?token=signed-token&v=1",
      configured: "configured-secret",
      cycle,
      err: new Error("provider timed out"),
    }, new Set(["configured-secret"]));

    expect(value).toMatchObject({
      authorization: "[REDACTED]",
      nested: { api_key: "[REDACTED]", prompt: "[REDACTED]" },
      callback: "https://blob.example/file",
      configured: "[REDACTED]",
      cycle: { password: "[REDACTED]", self: "[Circular]" },
      err: { name: "Error", message: "provider timed out" },
    });
  });

  it("adds active trace/span IDs while preserving its reserved envelope", () => {
    vi.restoreAllMocks();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(trace, "getActiveSpan").mockReturnValue({ spanContext: () => ({ traceId: "trace-123", spanId: "span-456", traceFlags: 1 }) } as never);
    log("error", "provider.failed", { trace_id: "spoofed", span_id: "spoofed" });
    expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toMatchObject({ trace_id: "trace-123", span_id: "span-456" });
    spy.mockRestore();
  });
});
