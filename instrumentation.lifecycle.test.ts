import { trace } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { registerOTel } from "@vercel/otel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedSpanProcessor, structuredSpanReadiness } from "./instrumentation";

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

describe("hosted request span lifecycle", () => {
  afterEach(() => {
    trace.disable();
    delete (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT];
  });

  it("exports a root that ends after @vercel/otel's initial 50ms waitUntil flush to both configured sinks", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({
        headers: {},
        url: "https://arena.example.test/slow-request",
        waitUntil: (task: Promise<unknown> | (() => Promise<unknown>)) => {
          waitUntilTasks.push(typeof task === "function" ? task() : task);
        },
      }),
    };

    const structuredExport = vi.fn((_spans: ReadableSpan[], callback: (result: { code: 0 }) => void) => callback({ code: 0 }));
    const otlpExport = vi.fn((_spans: ReadableSpan[], callback: (result: { code: 0 }) => void) => callback({ code: 0 }));
    const exporter = (exportSpans: typeof structuredExport) => ({
      export: exportSpans,
      forceFlush: async () => {},
      shutdown: async () => {},
    }) satisfies SpanExporter;

    registerOTel({
      serviceName: "hosted-lifecycle-test",
      instrumentations: [],
      spanProcessors: [
        new BoundedSpanProcessor(exporter(structuredExport), "structured"),
        new BoundedSpanProcessor(exporter(otlpExport), "otlp"),
      ],
    });

    const root = trace.getTracer("hosted-lifecycle-test").startSpan("slow-request-root");
    expect(waitUntilTasks).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 75));
    await Promise.all(waitUntilTasks);
    expect(structuredExport).not.toHaveBeenCalled();
    expect(otlpExport).not.toHaveBeenCalled();

    root.end();

    expect(structuredExport).not.toHaveBeenCalled();
    expect(otlpExport).not.toHaveBeenCalled();
    expect(structuredSpanReadiness()).toMatchObject({
      queued: 2,
      structured: { queued: 1 },
      otlp: { configured: true, queued: 1 },
    });

    await vi.waitFor(() => {
      expect(structuredExport).toHaveBeenCalledTimes(1);
      expect(otlpExport).toHaveBeenCalledTimes(1);
      expect(structuredSpanReadiness()).toMatchObject({
        queued: 0,
        structured: { queued: 0 },
        otlp: { configured: true, queued: 0 },
      });
    });
  });
});
