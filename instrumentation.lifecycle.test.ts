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

  it("binds every retained child and root to request-lifetime ownership", async () => {
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
    expect(waitUntilTasks).toHaveLength(8);

    root.end();
    expect(waitUntilTasks).toHaveLength(9);
    await Promise.all(waitUntilTasks);
    expect(batches.flat()).toHaveLength(9);
    await provider.shutdown();
  });

  it("runs the same bounded retained-span drain as a local fallback without request context", async () => {
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
    expect(waitUntilTasks).toHaveLength(32);
    let lifecycleSettled = false;
    const rootLifecycle = waitUntilTasks.at(-1)!;
    void rootLifecycle.then(() => { lifecycleSettled = true; });

    await vi.advanceTimersByTimeAsync(5_500);
    expect(exportSpans).toHaveBeenCalledTimes(2);
    expect(lifecycleSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    await rootLifecycle;
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
    expect(waitUntilTasks).toHaveLength(32);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exportSpans).toHaveBeenCalledTimes(2);
    for (const span of firstLateGeneration) span.end();
    expect(waitUntilTasks).toHaveLength(48);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(exportSpans).toHaveBeenCalledTimes(3);
    for (const span of secondLateGeneration) span.end();
    expect(waitUntilTasks).toHaveLength(64);
    let latestLifecycleSettled = false;
    const latestLifecycle = waitUntilTasks.at(-1)!;
    void latestLifecycle.then(() => { latestLifecycleSettled = true; });

    await vi.advanceTimersByTimeAsync(5_250);
    expect(exportSpans).toHaveBeenCalledTimes(4);
    expect(latestLifecycleSettled).toBe(false);
    expect(structuredSpanReadiness().structured.queued).toBe(16);

    await vi.advanceTimersByTimeAsync(2_750);
    await Promise.all(waitUntilTasks);
    expect(latestLifecycleSettled).toBe(true);
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

  it("binds a new lifecycle generation for a child started from a fully drained ended-root context", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({ waitUntil: (task: Promise<unknown>) => { waitUntilTasks.push(task); } }),
    };
    const exported: ReadableSpan[] = [];
    const exporter = {
      export: (spans: ReadableSpan[], callback: (result: { code: 0 }) => void) => { exported.push(...spans); callback({ code: 0 }); },
      forceFlush: async () => {},
      shutdown: async () => {},
    } satisfies SpanExporter;
    const provider = new BasicTracerProvider({ spanProcessors: [new BoundedSpanProcessor(exporter, "structured")] });
    const tracer = provider.getTracer("saved-ended-root-context");
    const root = tracer.startSpan("request-root");
    const savedRootContext = trace.setSpan(context.active(), root);

    root.end();
    await Promise.all(waitUntilTasks);
    expect(exported).toHaveLength(1);

    tracer.startSpan("post-drain-server-child", { kind: SpanKind.SERVER }, savedRootContext).end();
    expect(waitUntilTasks).toHaveLength(2);
    await waitUntilTasks[1];
    expect(exported).toHaveLength(2);
    await provider.shutdown();
  });

  it("owns nested, sibling, and out-of-order spans from saved contexts", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({ waitUntil: (task: Promise<unknown>) => { waitUntilTasks.push(task); } }),
    };
    const exported: ReadableSpan[] = [];
    const exportSpans = vi.fn((spans: ReadableSpan[], callback: (result: { code: 0 }) => void) => { exported.push(...spans); callback({ code: 0 }); });
    const exporter = { export: exportSpans, forceFlush: async () => {}, shutdown: async () => {} } satisfies SpanExporter;
    const provider = new BasicTracerProvider({ spanProcessors: [new BoundedSpanProcessor(exporter, "structured")] });
    const tracer = provider.getTracer("saved-ended-ancestry");
    const root = tracer.startSpan("request-root");
    const rootContext = trace.setSpan(context.active(), root);
    const nestedParent = tracer.startSpan("nested-parent", { kind: SpanKind.SERVER }, rootContext);
    const savedNestedContext = trace.setSpan(context.active(), nestedParent);
    nestedParent.end();
    root.end();
    await Promise.all(waitUntilTasks);
    expect(waitUntilTasks).toHaveLength(2);

    const firstSibling = tracer.startSpan("first-sibling", { kind: SpanKind.SERVER }, rootContext);
    const secondSibling = tracer.startSpan("second-sibling", { kind: SpanKind.SERVER }, rootContext);
    const nestedChild = tracer.startSpan("nested-child", { kind: SpanKind.SERVER }, savedNestedContext);
    secondSibling.end();
    nestedChild.end();
    firstSibling.end();

    expect(waitUntilTasks).toHaveLength(5);
    await Promise.all(waitUntilTasks);
    expect(exported).toHaveLength(5);
    await provider.shutdown();
  });

  it("keeps lifecycle ownership after more requests than the former ancestry cap", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({ waitUntil: (task: Promise<unknown>) => { waitUntilTasks.push(task); } }),
    };
    const exporter = {
      export: (_spans: ReadableSpan[], callback: (result: { code: 0 }) => void) => callback({ code: 0 }),
      forceFlush: async () => {},
      shutdown: async () => {},
    } satisfies SpanExporter;
    const provider = new BasicTracerProvider({ spanProcessors: [new BoundedSpanProcessor(exporter, "structured")] });
    const tracer = provider.getTracer("bounded-ended-ancestry");
    const savedRootContexts = [];
    for (let index = 0; index < 65; index += 1) {
      const root = tracer.startSpan(`request-root-${index}`);
      savedRootContexts.push(trace.setSpan(context.active(), root));
      root.end();
      await waitUntilTasks.at(-1);
    }
    expect(waitUntilTasks).toHaveLength(65);

    const droppedBefore = structuredSpanReadiness().structured.dropped;
    tracer.startSpan("oldest-root-child", { kind: SpanKind.SERVER }, savedRootContexts[0]).end();
    expect(waitUntilTasks).toHaveLength(66);
    await waitUntilTasks[65];
    tracer.startSpan("retained-root-child", { kind: SpanKind.SERVER }, savedRootContexts.at(-1)).end();
    expect(waitUntilTasks).toHaveLength(67);
    await waitUntilTasks[66];
    expect(structuredSpanReadiness().structured).toMatchObject({ ready: true, queued: 0, dropped: droppedBefore });
    await provider.shutdown();
  });

  it("keeps post-end lifecycle ownership beyond the former ancestry TTL", async () => {
    vi.useFakeTimers();
    const waitUntilTasks: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({ waitUntil: (task: Promise<unknown>) => { waitUntilTasks.push(task); } }),
    };
    const exporter = {
      export: (_spans: ReadableSpan[], callback: (result: { code: 0 }) => void) => callback({ code: 0 }),
      forceFlush: async () => {},
      shutdown: async () => {},
    } satisfies SpanExporter;
    const provider = new BasicTracerProvider({ spanProcessors: [new BoundedSpanProcessor(exporter, "structured")] });
    const tracer = provider.getTracer("expired-ended-ancestry");
    const root = tracer.startSpan("request-root");
    const savedRootContext = trace.setSpan(context.active(), root);
    root.end();
    await vi.advanceTimersByTimeAsync(0);
    await waitUntilTasks[0];

    const droppedBefore = structuredSpanReadiness().structured.dropped;
    await vi.advanceTimersByTimeAsync(160_251);
    tracer.startSpan("expired-root-child", { kind: SpanKind.SERVER }, savedRootContext).end();
    expect(waitUntilTasks).toHaveLength(2);
    await waitUntilTasks[1];
    expect(structuredSpanReadiness().structured).toMatchObject({ ready: true, queued: 0, dropped: droppedBefore });
    await provider.shutdown();
  });

  it("keeps an active child's lifecycle ownership while unrelated roots churn", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({ waitUntil: (task: Promise<unknown>) => { waitUntilTasks.push(task); } }),
    };
    const exporter = {
      export: (_spans: ReadableSpan[], callback: (result: { code: 0 }) => void) => callback({ code: 0 }),
      forceFlush: async () => {},
      shutdown: async () => {},
    } satisfies SpanExporter;
    const provider = new BasicTracerProvider({ spanProcessors: [new BoundedSpanProcessor(exporter, "structured")] });
    const tracer = provider.getTracer("active-child-root-churn");
    const rootA = tracer.startSpan("request-root-a");
    const rootAContext = trace.setSpan(context.active(), rootA);
    const activeChild = tracer.startSpan("active-child-a", { kind: SpanKind.SERVER }, rootAContext);
    rootA.end();
    await waitUntilTasks[0];

    for (let index = 0; index < 64; index += 1) {
      tracer.startSpan(`churn-root-${index}`).end();
      await waitUntilTasks.at(-1);
    }
    expect(waitUntilTasks).toHaveLength(65);

    activeChild.end();
    expect(waitUntilTasks).toHaveLength(66);
    await waitUntilTasks[65];
    expect(structuredSpanReadiness().structured).toMatchObject({ ready: true, queued: 0 });
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
    const rootAContext = trace.setSpan(context.active(), rootA);
    const rootBContext = trace.setSpan(context.active(), rootB);
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

    activeRequest = "request-a";
    tracer.startSpan("request-a-late-child", { kind: SpanKind.SERVER }, rootAContext).end();
    activeRequest = "request-b";
    tracer.startSpan("request-b-late-child", { kind: SpanKind.SERVER }, rootBContext).end();
    expect(tasksByRequest.get("request-a")).toHaveLength(2);
    expect(tasksByRequest.get("request-b")).toHaveLength(2);
    await Promise.all([...tasksByRequest.values()].flat());
    expect(structuredSpans).toHaveLength(4);
    expect(otlpSpans).toHaveLength(4);
    await provider.shutdown();
  });
});
