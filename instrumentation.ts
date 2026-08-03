import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel";
import { context, ROOT_CONTEXT, SpanStatusCode, type Attributes, type SpanContext, type SpanStatus } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SimpleSpanProcessor, type ReadableSpan, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Instrumentation } from "next";
import { log, normalizeError } from "./lib/log";

const SAFE_RESOURCE = resourceFromAttributes({ "service.name": "harness-arena" });
const SAFE_SCOPE = { name: "harness-arena-sanitized" };

function safeAttributes(attributes: Attributes): Attributes {
  const safe: Attributes = {};
  const method = attributes["http.request.method"];
  const status = attributes["http.response.status_code"];
  if (typeof method === "string" && /^[A-Z]{1,16}$/.test(method)) safe["http.request.method"] = method;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) safe["http.response.status_code"] = status;
  return safe;
}

function safeContext(context: SpanContext): SpanContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    traceFlags: context.traceFlags,
    ...(context.isRemote === undefined ? {} : { isRemote: context.isRemote }),
  };
}

function safeStatus(status: SpanStatus): SpanStatus {
  const code = [SpanStatusCode.UNSET, SpanStatusCode.OK, SpanStatusCode.ERROR].includes(status.code) ? status.code : SpanStatusCode.UNSET;
  return { code };
}

/** Constructs the complete allowlisted object handed to the real exporter. */
export function safeExportSpan(span: ReadableSpan): ReadableSpan {
  const context = safeContext(span.spanContext());
  return {
    name: "harness.span",
    kind: span.kind,
    spanContext: () => context,
    ...(span.parentSpanContext ? { parentSpanContext: safeContext(span.parentSpanContext) } : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    status: safeStatus(span.status),
    attributes: safeAttributes(span.attributes),
    links: [],
    events: [],
    duration: span.duration,
    ended: span.ended,
    resource: SAFE_RESOURCE,
    instrumentationScope: SAFE_SCOPE,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

export class SafeSpanExporter implements SpanExporter {
  constructor(private readonly delegate: SpanExporter) {}
  export(spans: ReadableSpan[], callback: Parameters<SpanExporter["export"]>[1]): void {
    this.delegate.export(spans.map(safeExportSpan), callback);
  }
  forceFlush(): Promise<void> { return this.delegate.forceFlush?.() ?? Promise.resolve(); }
  shutdown(): Promise<void> { return this.delegate.shutdown(); }
}

/** Durable, provider-neutral fallback: Vercel captures these JSON lines in runtime logs. */
export class StructuredSpanExporter implements SpanExporter {
  export(spans: ReadableSpan[], callback: Parameters<SpanExporter["export"]>[1]): void {
    try {
      for (const span of spans) {
        const spanContext = span.spanContext();
        // Do not let an unrelated active span overwrite the ended span IDs in
        // log()'s reserved envelope.
        context.with(ROOT_CONTEXT, () => log("info", "trace.span", {
          trace_id: spanContext.traceId,
          span_id: spanContext.spanId,
          ...(span.parentSpanContext?.spanId ? { parent_span_id: span.parentSpanContext.spanId } : {}),
          span_name: span.name,
          span_kind: span.kind,
          span_status: span.status.code,
          ...span.attributes,
        }));
      }
      callback({ code: 0 });
    } catch (error) {
      callback({ code: 1, error: error instanceof Error ? error : new Error("structured span export failed") });
    }
  }
  forceFlush(): Promise<void> { return Promise.resolve(); }
  shutdown(): Promise<void> { return Promise.resolve(); }
}

function configuredCollectorUrl(): string | null {
  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (tracesEndpoint) return tracesEndpoint;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/$/, "");
  if (endpoint) return `${endpoint}/v1/traces`;
  if (!process.env.VERCEL_OTEL_ENDPOINTS) return null;
  const protocol = process.env.VERCEL_OTEL_ENDPOINTS_PROTOCOL?.trim() || "http/protobuf";
  if (protocol !== "http/protobuf") return null;
  const rawPort = process.env.VERCEL_OTEL_ENDPOINTS_PORT?.trim() || "4318";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return `http://localhost:${port}/v1/traces`;
}

/** Uses the supported onEnd/export lifecycle; readonly SDK spans are never mutated. */
export function createSafeSpanProcessor(exporter: SpanExporter = new StructuredSpanExporter()): SpanProcessor {
  return new SimpleSpanProcessor(new SafeSpanExporter(exporter));
}

/**
 * Runtime logs are the always-on trace sink. OTLP is additive only when the
 * environment proves a collector exists, avoiding silent localhost export.
 */
export function createSafeSpanProcessors(): SpanProcessor[] {
  const processors: SpanProcessor[] = [createSafeSpanProcessor()];
  const collectorUrl = configuredCollectorUrl();
  if (collectorUrl) processors.push(createSafeSpanProcessor(new OTLPHttpProtoTraceExporter({ url: collectorUrl })));
  return processors;
}

export function register() {
  registerOTel({
    serviceName: "harness-arena",
    // An explicit processor disables @vercel/otel's parallel automatic
    // exporters, ensuring every exported field crosses the safe clone boundary.
    spanProcessors: createSafeSpanProcessors(),
  });
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  // Deliberately omit headers/body. log() strips path query strings.
  log("error", "request.error", {
    ...normalizeError(error, "request"),
    request: { method: request.method, path: request.path },
    route: { router_kind: context.routerKind, route_path: context.routePath, route_type: context.routeType },
  });
};
