import { context, SpanKind, trace } from "@opentelemetry/api";
import { BasicTracerProvider, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { registerOTel } from "@vercel/otel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedSpanProcessor, structuredSpanReadiness } from "./instrumentation";

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

describe("hosted request span lifecycle", () => {
  afterEach(() => {
    trace.disable();
    vi.useRealTimers();
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
    expect(waitUntilTasks).toHaveLength(2);
  });

  it("coalesces retained children behind one post-root request-lifetime drain", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({ waitUntil: (task: Promise<unknown>) => { waitUntilTasks.push(task); } }),
    };
    const batches: ReadableSpan[][] = [];
    const exporter = {
      export: (spans: ReadableSpan[], callback: (result: { code: 0 }) => void) => { batches.push(spans); callback({ code: 0 }); },
      forceFlush: async () => {},
      shutdown: async () => {},
    } satisfies SpanExporter;
    const provider = new BasicTracerProvider({ spanProcessors: [new BoundedSpanProcessor(exporter, "structured")] });
    const tracer = provider.getTracer("coalesced-root-drain");
    const root = tracer.startSpan("request-root");
    const rootContext = trace.setSpan(context.active(), root);

    for (let index = 0; index < 8; index += 1) {
      tracer.startSpan(`server-child-${index}`, { kind: SpanKind.SERVER }, rootContext).end();
    }
    expect(waitUntilTasks).toHaveLength(0);

    root.end();
    expect(waitUntilTasks).toHaveLength(1);
    await Promise.all(waitUntilTasks);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(9);
    await provider.shutdown();
  });

  it("runs the same bounded post-root drain as a local fallback without request context", async () => {
    const exportSpans = vi.fn((_spans: ReadableSpan[], callback: (result: { code: 0 }) => void) => callback({ code: 0 }));
    const exporter = { export: exportSpans, forceFlush: async () => {}, shutdown: async () => {} } satisfies SpanExporter;
    const provider = new BasicTracerProvider({ spanProcessors: [new BoundedSpanProcessor(exporter, "structured")] });

    provider.getTracer("local-root-drain").startSpan("request-root").end();

    await vi.waitFor(() => {
      expect(exportSpans).toHaveBeenCalledTimes(1);
      expect(structuredSpanReadiness().structured.queued).toBe(0);
    });
    await provider.shutdown();
  });

  it("keeps the request lifetime open for two serial slow-success batches at maximum queue capacity", async () => {
    vi.useFakeTimers();
    const waitUntilTasks: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({ waitUntil: (task: Promise<unknown>) => { waitUntilTasks.push(task); } }),
    };
    const exportSpans = vi.fn((_spans: ReadableSpan[], callback: (result: { code: 0 }) => void) => {
      setTimeout(() => callback({ code: 0 }), 3_000);
    });
    const exporter = { export: exportSpans, forceFlush: async () => {}, shutdown: async () => {} } satisfies SpanExporter;
    const provider = new BasicTracerProvider({ spanProcessors: [new BoundedSpanProcessor(exporter, "structured")] });
    const tracer = provider.getTracer("two-batch-root-drain");
    const root = tracer.startSpan("request-root");
    const rootContext = trace.setSpan(context.active(), root);
    for (let index = 0; index < 31; index += 1) {
      tracer.startSpan(`server-child-${index}`, { kind: SpanKind.SERVER }, rootContext).end();
    }

    root.end();
    expect(waitUntilTasks).toHaveLength(1);
    let lifecycleSettled = false;
    void waitUntilTasks[0]!.then(() => { lifecycleSettled = true; });

    await vi.advanceTimersByTimeAsync(5_500);
    expect(exportSpans).toHaveBeenCalledTimes(2);
    expect(lifecycleSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    await waitUntilTasks[0];
    expect(lifecycleSettled).toBe(true);
    expect(structuredSpanReadiness().structured.queued).toBe(0);
    await provider.shutdown();
  });

  it("binds each post-snapshot arrival generation while a fourth export batch is active", async () => {
    vi.useFakeTimers();
    const waitUntilTasks: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({ waitUntil: (task: Promise<unknown>) => { waitUntilTasks.push(task); } }),
    };
    const exportSpans = vi.fn((_spans: ReadableSpan[], callback: (result: { code: 0 }) => void) => {
      setTimeout(() => callback({ code: 0 }), 4_500);
    });
    const exporter = { export: exportSpans, forceFlush: async () => {}, shutdown: async () => {} } satisfies SpanExporter;
    const provider = new BasicTracerProvider({ spanProcessors: [new BoundedSpanProcessor(exporter, "structured")] });
    const tracer = provider.getTracer("late-generation-root-drain");
    const root = tracer.startSpan("request-root");
    const rootContext = trace.setSpan(context.active(), root);
    for (let index = 0; index < 31; index += 1) {
      tracer.startSpan(`initial-server-child-${index}`, { kind: SpanKind.SERVER }, rootContext).end();
    }
    const firstLateGeneration = Array.from({ length: 16 }, (_, index) =>
      tracer.startSpan(`first-late-server-child-${index}`, { kind: SpanKind.SERVER }, rootContext));
    const secondLateGeneration = Array.from({ length: 16 }, (_, index) =>
      tracer.startSpan(`second-late-server-child-${index}`, { kind: SpanKind.SERVER }, rootContext));

    root.end();
    expect(waitUntilTasks).toHaveLength(1);
    const lifecycleSettled: boolean[] = [];
    const observeLifecycleTasks = () => {
      for (let index = lifecycleSettled.length; index < waitUntilTasks.length; index += 1) {
        lifecycleSettled[index] = false;
        void waitUntilTasks[index]!.then(() => { lifecycleSettled[index] = true; });
      }
    };
    observeLifecycleTasks();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exportSpans).toHaveBeenCalledTimes(2);
    for (const span of firstLateGeneration) span.end();
    expect(waitUntilTasks).toHaveLength(2);
    observeLifecycleTasks();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(exportSpans).toHaveBeenCalledTimes(3);
    for (const span of secondLateGeneration) span.end();
    expect(waitUntilTasks).toHaveLength(3);
    observeLifecycleTasks();

    await vi.advanceTimersByTimeAsync(5_250);
    expect(exportSpans).toHaveBeenCalledTimes(4);
    expect(lifecycleSettled).toEqual([true, true, false]);
    expect(structuredSpanReadiness().structured.queued).toBe(16);

    await vi.advanceTimersByTimeAsync(2_750);
    await Promise.all(waitUntilTasks);
    expect(lifecycleSettled).toEqual([true, true, true]);
    expect(structuredSpanReadiness().structured.queued).toBe(0);
    await provider.shutdown();
  });

  it("coalesces both sinks into one lifecycle task for a late generation", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({ waitUntil: (task: Promise<unknown>) => { waitUntilTasks.push(task); } }),
    };
    const structuredSpans: ReadableSpan[] = [];
    const otlpSpans: ReadableSpan[] = [];
    const exporter = (captured: ReadableSpan[]) => ({
      export: (spans: ReadableSpan[], callback: (result: { code: 0 }) => void) => { captured.push(...spans); callback({ code: 0 }); },
      forceFlush: async () => {},
      shutdown: async () => {},
    }) satisfies SpanExporter;
    const provider = new BasicTracerProvider({ spanProcessors: [
      new BoundedSpanProcessor(exporter(structuredSpans), "structured"),
      new BoundedSpanProcessor(exporter(otlpSpans), "otlp"),
    ] });
    const tracer = provider.getTracer("late-generation-two-sink-drain");
    const root = tracer.startSpan("request-root");
    const rootContext = trace.setSpan(context.active(), root);
    const lateChild = tracer.startSpan("late-server-child", { kind: SpanKind.SERVER }, rootContext);

    root.end();
    expect(waitUntilTasks).toHaveLength(1);
    await Promise.resolve();
    lateChild.end();
    expect(waitUntilTasks).toHaveLength(2);

    await Promise.all(waitUntilTasks);
    expect(structuredSpans).toHaveLength(2);
    expect(otlpSpans).toHaveLength(2);
    await provider.shutdown();
  });

  it("binds one aggregate two-sink lifecycle task to each concurrent root request context in the same incoming trace", async () => {
    const tasksByRequest = new Map<string, Promise<unknown>[]>([["request-a", []], ["request-b", []]]);
    let activeRequest = "request-a";
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({
        waitUntil: (task: Promise<unknown>) => { tasksByRequest.get(activeRequest)!.push(task); },
      }),
    };
    const structuredSpans: ReadableSpan[] = [];
    const otlpSpans: ReadableSpan[] = [];
    const exporter = (captured: ReadableSpan[]) => ({
      export: (spans: ReadableSpan[], callback: (result: { code: 0 }) => void) => { captured.push(...spans); callback({ code: 0 }); },
      forceFlush: async () => {},
      shutdown: async () => {},
    }) satisfies SpanExporter;
    const provider = new BasicTracerProvider({ spanProcessors: [
      new BoundedSpanProcessor(exporter(structuredSpans), "structured"),
      new BoundedSpanProcessor(exporter(otlpSpans), "otlp"),
    ] });
    const tracer = provider.getTracer("concurrent-root-drains");
    const incomingParent = trace.setSpan(context.active(), trace.wrapSpanContext({
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      traceFlags: 1,
      isRemote: true,
    }));
    const rootA = tracer.startSpan("request-a-root", undefined, incomingParent);
    const rootB = tracer.startSpan("request-b-root", undefined, incomingParent);
    expect(rootA.spanContext().traceId).toBe(rootB.spanContext().traceId);
    expect(rootA.spanContext().spanId).not.toBe(rootB.spanContext().spanId);
    const rootIds = [rootA.spanContext().spanId, rootB.spanContext().spanId].sort();

    activeRequest = "request-a";
    rootA.end();
    activeRequest = "request-b";
    rootB.end();

    expect(tasksByRequest.get("request-a")).toHaveLength(1);
    expect(tasksByRequest.get("request-b")).toHaveLength(1);
    await Promise.all([...tasksByRequest.values()].flat());
    expect(structuredSpans.map((span) => span.spanContext().spanId).sort()).toEqual(rootIds);
    expect(otlpSpans.map((span) => span.spanContext().spanId).sort()).toEqual(rootIds);
    await provider.shutdown();
  });
});
