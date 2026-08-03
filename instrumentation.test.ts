import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedSpanProcessor, createSafeSpanProcessors, createSafeSpanProcessor, onRequestError, parseOtlpHeaders, StructuredSpanExporter, structuredSpanReadiness } from "./instrumentation";

describe("onRequestError", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("awaits structured safe Error telemetry without raw error text or stack", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = Object.assign(new Error("gateway timeout"), { digest: "digest-42" });
    await onRequestError(error, {
      path: "/api/runs?token=signed-value",
      method: "POST",
      headers: { authorization: "Bearer secret", cookie: "session=secret" },
    }, {
      routerKind: "App Router",
      routePath: "/api/runs",
      routeType: "route",
    } as never);
    const line = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(line).toMatchObject({
      event: "request.error",
      error_schema: "v1",
      error_class: "error",
      error_fingerprint: expect.stringMatching(/^fnv1a-[0-9a-f]{8}$/),
      error_stage: "request",
      request: { method: "POST", path: "/api/runs" },
    });
    for (const forbidden of ["gateway timeout", "digest-42", "secret", "signed-value", "error_stack", "error_message"]) expect(JSON.stringify(line)).not.toContain(forbidden);
    spy.mockRestore();
  });

  it("records non-Error throws without leaking request data", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(onRequestError("bad callback payload", {
      path: "/api/runs/r1/callback?signature=secret",
      method: "POST",
      headers: { cookie: "secret" },
    }, { routerKind: "App Router", routePath: "/api/runs/[id]/callback", routeType: "route" } as never)).resolves.toBeUndefined();
    const line = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(line).toMatchObject({ error_schema: "v1", error_class: "non_error", error_stage: "request" });
    expect(JSON.stringify(line)).not.toContain("secret");
    spy.mockRestore();
  });

  it("exports only a safe clone through the real SpanProcessor onEnd lifecycle", async () => {
    const captured: ReadableSpan[] = [];
    const exporter: SpanExporter = {
      export(spans, callback) { captured.push(...spans); callback({ code: 0 }); },
      forceFlush: async () => {},
      shutdown: async () => {},
    };
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": "secret-resource-name", "host.url": "https://host.test?token=secret" }),
      spanProcessors: [createSafeSpanProcessor(exporter)],
    });
    const span = provider.getTracer("hostile?scope=secret").startSpan("GET https://arena.example/api/runs?token=secret", {
      kind: SpanKind.SERVER,
      attributes: {
        "url.full": "https://arena.example/api/runs?token=secret",
        "http.target": "/api/runs?signature=secret",
        "http.request.header.authorization": "Bearer secret",
        "http.request.method": "POST",
        "http.response.status_code": 503,
        "custom.attribute": "secret provider payload",
      },
      links: [{ context: { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 }, attributes: { payload: "secret-link" } }],
    });
    span.recordException(new Error("secret exception message"));
    span.setStatus({ code: SpanStatusCode.ERROR, message: "secret status message" });
    span.end();
    await provider.forceFlush();

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      name: "harness.span",
      attributes: { "http.request.method": "POST", "http.response.status_code": 503 },
      status: { code: SpanStatusCode.ERROR },
      events: [], links: [],
      instrumentationScope: { name: "harness-arena-sanitized" },
      resource: { attributes: { "service.name": "harness-arena" } },
    });
    const exported = JSON.stringify(captured[0]);
    for (const forbidden of ["secret", "token=", "signature=", "exception.message", "exception.stacktrace"]) expect(exported).not.toContain(forbidden);
    await provider.shutdown();
  });

  it("always exports a queryable safe trace event when no OTLP collector is configured", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    vi.stubEnv("VERCEL_OTEL_ENDPOINTS", "");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "host.url": "https://host.test?token=secret" }),
      spanProcessors: createSafeSpanProcessors(),
    });
    provider.getTracer("hostile?scope=secret").startSpan("GET /api/runs?token=secret", {
      attributes: { "http.request.method": "GET", "url.full": "https://host.test?token=secret" },
    }).end();
    await provider.forceFlush();

    const records = spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(records).toContainEqual(expect.objectContaining({
      event: "trace.span",
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      span_id: expect.stringMatching(/^[0-9a-f]{16}$/),
      span_name: "harness.span",
    }));
    expect(JSON.stringify(records)).not.toContain("secret");
    spy.mockRestore();
    await provider.shutdown();
  });

  it("adds OTLP delivery only when a collector is explicitly available", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    vi.stubEnv("VERCEL_OTEL_ENDPOINTS", "");
    expect(createSafeSpanProcessors()).toHaveLength(1);
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://collector.example.test/v1/traces");
    expect(createSafeSpanProcessors()).toHaveLength(2);
  });

  it("fails structured export when the runtime log sink does not acknowledge retention", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => { throw new Error("runtime log sink unavailable"); });
    const exporter = new StructuredSpanExporter();
    const span = { name: "root", kind: SpanKind.SERVER, spanContext: () => ({ traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 }), status: { code: SpanStatusCode.OK }, attributes: {} } as ReadableSpan;
    const result = await new Promise<{ code: number }>((resolve) => exporter.export([span], resolve));
    expect(result.code).toBe(1);
    spy.mockRestore();
  });

  it("bounds automatic span retention, preserves a root span, and publishes safe drop readiness", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exporter = { export: vi.fn((_spans: ReadableSpan[], callback: (result: { code: 0 }) => void) => callback({ code: 0 })), forceFlush: async () => {}, shutdown: async () => {} } satisfies SpanExporter;
    const processor = createSafeSpanProcessor(exporter);
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    const tracer = provider.getTracer("test");
    tracer.startSpan("root").end();
    for (let index = 0; index < 100; index += 1) tracer.startSpan(`automatic-${index}`).end();
    await provider.forceFlush();
    expect(exporter.export).toHaveBeenCalled();
    expect(structuredSpanReadiness()).toMatchObject({ ready: true, dropped: expect.any(Number) });
    expect(structuredSpanReadiness().dropped).toBeGreaterThan(0);
    await provider.shutdown();
    logSpy.mockRestore();
  });

  it("evicts a lower-priority retained child so a root that ends last survives the bounded queue", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const captured: ReadableSpan[] = [];
    const exporter = {
      export: vi.fn((spans: ReadableSpan[], callback: (result: { code: 0 }) => void) => { captured.push(...spans); callback({ code: 0 }); }),
      forceFlush: async () => {},
      shutdown: async () => {},
    } satisfies SpanExporter;
    const processor = new BoundedSpanProcessor(exporter, "structured");
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    const tracer = provider.getTracer("priority-test");
    const root = tracer.startSpan("request-root", { kind: SpanKind.INTERNAL });
    const rootSpanId = root.spanContext().spanId;
    const droppedBefore = structuredSpanReadiness().structured.dropped;

    const rootContext = trace.setSpan(context.active(), root);
    for (let index = 0; index < 32; index += 1) tracer.startSpan(`server-child-${index}`, { kind: SpanKind.SERVER }, rootContext).end();
    root.end();
    await provider.forceFlush();

    expect(captured).toHaveLength(32);
    expect(captured.some((span) => span.spanContext().spanId === rootSpanId)).toBe(true);
    expect(structuredSpanReadiness().structured).toMatchObject({ queued: 0, dropped: droppedBefore + 1 });
    expect(logSpy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)).toContainEqual(expect.objectContaining({
      event: "trace.span_dropped", reason: "priority_evicted", sink: "structured",
    }));
    await provider.shutdown();
    logSpy.mockRestore();
  });

  it("evicts local children so a request root under a remote parent survives the bounded queue", async () => {
    const captured: ReadableSpan[] = [];
    const exporter = {
      export: vi.fn((spans: ReadableSpan[], callback: (result: { code: 0 }) => void) => { captured.push(...spans); callback({ code: 0 }); }),
      forceFlush: async () => {},
      shutdown: async () => {},
    } satisfies SpanExporter;
    const processor = new BoundedSpanProcessor(exporter, "structured");
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    const tracer = provider.getTracer("remote-priority-test");
    const remoteParentContext = trace.setSpan(context.active(), trace.wrapSpanContext({
      traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1, isRemote: true,
    }));
    const requestRoot = tracer.startSpan("request-root", { kind: SpanKind.INTERNAL }, remoteParentContext);
    const requestRootSpanId = requestRoot.spanContext().spanId;
    const requestContext = trace.setSpan(context.active(), requestRoot);

    for (let index = 0; index < 32; index += 1) tracer.startSpan(`server-child-${index}`, { kind: SpanKind.SERVER }, requestContext).end();
    requestRoot.end();
    await provider.forceFlush();

    expect(captured).toHaveLength(32);
    expect(captured.some((span) => span.spanContext().spanId === requestRootSpanId)).toBe(true);
    await provider.shutdown();
  });

  it("keeps a failed OTLP batch bounded and retryable without letting structured delivery hide its failure", async () => {
    let acknowledge = false;
    const exporter = {
      export: vi.fn((_spans: ReadableSpan[], callback: (result: { code: number; error?: Error }) => void) =>
        callback(acknowledge ? { code: 0 } : { code: 1, error: new Error("collector unavailable") })),
      forceFlush: async () => {},
      shutdown: async () => {},
    } satisfies SpanExporter;
    const processor = new BoundedSpanProcessor(exporter, "otlp");
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    provider.getTracer("test").startSpan("root").end();

    await expect(provider.forceFlush()).rejects.toBeDefined();
    expect(structuredSpanReadiness()).toMatchObject({
      ready: false,
      otlp: { configured: true, ready: false, queued: 1, reason: "export_unacknowledged" },
    });

    const structured = new BoundedSpanProcessor({
      export: (_spans, callback) => callback({ code: 0 }),
      forceFlush: async () => {},
      shutdown: async () => {},
    }, "structured");
    const structuredProvider = new BasicTracerProvider({ spanProcessors: [structured] });
    structuredProvider.getTracer("test").startSpan("structured-root").end();
    await structuredProvider.forceFlush();
    expect(structuredSpanReadiness()).toMatchObject({ ready: false, otlp: { ready: false, reason: "export_unacknowledged" } });

    acknowledge = true;
    await provider.forceFlush();
    expect(exporter.export).toHaveBeenCalledTimes(2);
    expect(structuredSpanReadiness()).toMatchObject({ ready: true, otlp: { configured: true, ready: true, queued: 0 } });
    await provider.shutdown();
    await structuredProvider.shutdown();
  });

  it("coalesces concurrent flushes so one queued batch is exported exactly once", async () => {
    const callbacks: Array<(result: { code: number }) => void> = [];
    const exporter = {
      export: vi.fn((_spans: ReadableSpan[], callback: (result: { code: number }) => void) => callbacks.push(callback)),
      forceFlush: async () => {},
      shutdown: async () => {},
    } satisfies SpanExporter;
    const processor = new BoundedSpanProcessor(exporter, "structured");
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    provider.getTracer("test").startSpan("one-root").end();

    const flushes = [provider.forceFlush(), provider.forceFlush()];
    try {
      expect(exporter.export).toHaveBeenCalledTimes(1);
    } finally {
      for (const callback of callbacks) callback({ code: 0 });
      await Promise.allSettled(flushes);
    }
    expect(structuredSpanReadiness().structured.queued).toBe(0);
    await provider.shutdown();
  });

  it("emits one sanitized hosted sink-state transition on OTLP export failure and one on recovery", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let acknowledge = false;
    const exporter = {
      export: vi.fn((_spans: ReadableSpan[], callback: (result: { code: number; error?: Error }) => void) => callback(
        acknowledge ? { code: 0 } : { code: 1, error: new Error("collector unavailable authorization=secret-value") },
      )),
      forceFlush: async () => {},
      shutdown: async () => {},
    } satisfies SpanExporter;
    const processor = new BoundedSpanProcessor(exporter, "otlp");
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    provider.getTracer("sink-state-test").startSpan("request-root").end();

    await expect(provider.forceFlush()).rejects.toBeDefined();
    provider.getTracer("sink-state-test").startSpan("queued-after-failure").end();
    acknowledge = true;
    await provider.forceFlush();

    const transitions = logSpy.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((entry) => entry.event === "trace.sink_state");
    expect(transitions).toEqual([
      expect.objectContaining({ event: "trace.sink_state", sink: "otlp", state: "degraded", reason: "export_unacknowledged", queued: 1, dropped: expect.any(Number) }),
      expect.objectContaining({ event: "trace.sink_state", sink: "otlp", state: "ready", queued: 0, dropped: expect.any(Number) }),
    ]);
    expect(JSON.stringify(transitions)).not.toContain("secret-value");
    await provider.shutdown();
    logSpy.mockRestore();
  });

  it("fails closed for unsupported configured OTLP protocol without exposing header values", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://collector.example.test/v1/traces");
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "grpc");
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "authorization=Bearer secret-value");
    expect(createSafeSpanProcessors()).toHaveLength(1);
    expect(structuredSpanReadiness()).toMatchObject({ ready: false, reason: "unsupported_protocol" });
  });

  it("accepts standard trace-specific HTTP JSON headers without emitting their values", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://collector.example.test/v1/traces");
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "http/json");
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "x-tenant=arena,authorization=Bearer secret-value");
    expect(createSafeSpanProcessors()).toHaveLength(2);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret-value");
    spy.mockRestore();
  });

  it("decodes valid percent-encoded OTLP header values exactly without logging them", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://collector.example.test/v1/traces");
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "http/json");
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "x-tenant=arena%2Ceu,authorization=Bearer%20secret%2Dvalue");
    expect(parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS)).toEqual({ "x-tenant": "arena,eu", authorization: "Bearer secret-value" });
    expect(createSafeSpanProcessors()).toHaveLength(2);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret-value");
    spy.mockRestore();
  });

  it("fails closed for malformed percent-encoded OTLP headers without logging their values", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://collector.example.test/v1/traces");
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "authorization=Bearer%ZZsecret-value");
    expect(createSafeSpanProcessors()).toHaveLength(1);
    expect(structuredSpanReadiness()).toMatchObject({ ready: false, otlp: { configured: true, ready: false, reason: "invalid_headers" } });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret-value");
    spy.mockRestore();
  });

  it("emits an invalid OTLP configuration transition once without endpoint or header values", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://collector.example.test/v1/traces");
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "");
    expect(createSafeSpanProcessors()).toHaveLength(2);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://collector.example.test/v1/traces?secret=endpoint-value");
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "authorization=Bearer%ZZheader-value");
    expect(createSafeSpanProcessors()).toHaveLength(1);
    expect(createSafeSpanProcessors()).toHaveLength(1);

    const transitions = spy.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((entry) => entry.event === "trace.sink_state");
    expect(transitions).toEqual([
      expect.objectContaining({ event: "trace.sink_state", sink: "otlp", state: "degraded", reason: "invalid_headers", queued: 0, dropped: 0 }),
    ]);
    expect(JSON.stringify(transitions)).not.toMatch(/endpoint-value|header-value|collector\.example/);
    spy.mockRestore();
  });
});
