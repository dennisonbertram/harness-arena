import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { createSafeSpanProcessor, onRequestError } from "./instrumentation";

describe("onRequestError", () => {
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
});
