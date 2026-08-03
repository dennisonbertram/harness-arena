import { describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { log, MAX_LOG_BYTES, normalizeError, redactLogValue } from "./log";

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

  it("acknowledges successful emission and reports console failure", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(log("info", "monitor.observation", { verdict: "healthy" })).toBe(true);
    spy.mockImplementation(() => { throw new Error("stdout unavailable"); });
    expect(log("error", "monitor.observation", { verdict: "failed" })).toBe(false);
    spy.mockRestore();
  });

  it("reports serialization failure even when its bounded fallback is emitted", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const original = JSON.stringify;
    const stringify = vi.spyOn(JSON, "stringify").mockImplementationOnce(() => { throw new Error("serialization failed"); }).mockImplementation(original);
    expect(log("error", "monitor.observation", { verdict: "failed" })).toBe(false);
    expect(consoleSpy).toHaveBeenCalledOnce();
    stringify.mockRestore();
    consoleSpy.mockRestore();
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
      err: { error_schema: "v1", error_class: "error", error_stage: "unknown", error_fingerprint: expect.any(String) },
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

  it("scrubs embedded bearer tokens, signed absolute/relative URLs, and overlapping configured secrets everywhere", () => {
    const secrets = new Set(["secret", "secret-long"]);
    const value = redactLogValue({
      text: "failed with Bearer token-value at https://blob.example/file?token=query-value and GET /file?signature=relative-value",
      path: "/api/secret-long/results",
      nested: ["prefix-secret-long-suffix"],
      error: Object.assign(new Error("Bearer error-token fetching https://blob.example/a?sig=error-query"), {
        stack: "Error: secret-long\n at GET /signed?token=stack-query",
      }),
    }, secrets);
    const output = JSON.stringify(value);

    for (const forbidden of ["token-value", "query-value", "relative-value", "secret-long", "error-token", "error-query", "stack-query"]) {
      expect(output).not.toContain(forbidden);
    }
  });

  it("bounds huge strings, arrays, objects, and the total emitted record", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const hugeObject = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`field_${i}`, "x".repeat(2_000)]));

    expect(() => log("error", "huge.failure", {
      huge_string: "x".repeat(2 * 1024 * 1024),
      huge_array: Array.from({ length: 100_000 }, (_, i) => i),
      huge_object: hugeObject,
    })).not.toThrow();
    expect(Buffer.byteLength(spy.mock.calls[0]?.[0] as string)).toBeLessThanOrEqual(MAX_LOG_BYTES);
    spy.mockRestore();
  });

  it("never throws for cycles or enumerable getters that throw", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const hostile: Record<string, unknown> = {};
    hostile.self = hostile;
    Object.defineProperty(hostile, "boom", { enumerable: true, get: () => { throw new Error("getter secret"); } });

    expect(() => log("error", "hostile.failure", { hostile })).not.toThrow();
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("emits only the allowlisted error schema and fingerprints arbitrary error text", () => {
    const error = Object.assign(new TypeError("bad token"), { digest: "digest-1", stack: `TypeError: bad token\n${"at frame\n".repeat(100)}` });
    expect(normalizeError(error, "provider_request", new Set(["token"]))).toMatchObject({
      error_schema: "v1",
      error_class: "type_error",
      error_fingerprint: expect.stringMatching(/^fnv1a-[0-9a-f]{8}$/),
      error_stage: "provider_request",
    });
    expect(normalizeError("plain failure", "callback_validation")).toMatchObject({
      error_schema: "v1",
      error_class: "non_error",
      error_stage: "callback_validation",
    });
    const output = JSON.stringify(normalizeError(error, "provider_request", new Set(["token"])));
    for (const forbidden of ["bad token", "digest-1", "TypeError:", "at frame"]) expect(output).not.toContain(forbidden);
  });

  it("bounds hostile strings before redaction work while retaining a bounded safe result", () => {
    const hostile = `Bearer ${"x".repeat(4 * 1024 * 1024)} secret-after-the-boundary`;
    const output = redactLogValue(hostile, new Set(["secret-after-the-boundary"]));
    expect(typeof output).toBe("string");
    expect((output as string).length).toBeLessThanOrEqual(2_048);
    expect(output).not.toContain("secret-after-the-boundary");
  });

  it("does not leak the prefix of a configured secret longer than the input bound", () => {
    const longSecret = `prefix-${"s".repeat(3_000)}`;
    const output = String(redactLogValue(`provider returned ${longSecret}`, new Set([longSecret])));
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain(longSecret.slice(0, 128));
    expect(output.length).toBeLessThanOrEqual(2_048);
  });

  it("redacts a long secret beginning within the final 63 retained characters", () => {
    const marker = "...[Truncated]";
    const retainedLimit = 2_048 - marker.length;
    const visibleSecretPrefixLength = 37;
    const longSecret = `edge-secret-${"q".repeat(3_000)}`;
    const padding = "x".repeat(retainedLimit - visibleSecretPrefixLength);
    const output = String(redactLogValue(`${padding}${longSecret}`, new Set([longSecret])));

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain(longSecret.slice(0, visibleSecretPrefixLength));
    expect(output.length).toBeLessThanOrEqual(2_048);
  });

  it("uses a safe fallback for a Proxy that throws during instanceof", () => {
    const hostile = new Proxy(new Error("must stay unread"), {
      getPrototypeOf: () => { throw new Error("hostile getPrototypeOf"); },
    });
    expect(() => normalizeError(hostile, "request")).not.toThrow();
    expect(normalizeError(hostile, "request")).toMatchObject({ error_class: "error", error_stage: "request" });
  });

  it("never emits a 2,049-character truncation result", () => {
    const output = String(redactLogValue("x".repeat(10_000), new Set()));
    expect(output).toHaveLength(2_048);
    expect(output.endsWith("...[Truncated]")).toBe(true);
  });

  it("normalizes an Error with a hostile name getter without throwing", () => {
    const hostile = new Error("payload must stay unread");
    Object.defineProperty(hostile, "name", { get: () => { throw new Error("hostile name getter"); } });
    expect(() => normalizeError(hostile, "request")).not.toThrow();
    expect(normalizeError(hostile, "request")).toMatchObject({ error_class: "error", error_stage: "request" });
  });
});
