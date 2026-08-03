import { OTLPHttpJsonTraceExporter, OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel";
import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, type Attributes, type SpanContext, type SpanStatus } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { type ReadableSpan, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Instrumentation } from "next";
import { log, normalizeError } from "./lib/log";

const SAFE_RESOURCE = resourceFromAttributes({ "service.name": "harness-arena" });
const SAFE_SCOPE = { name: "harness-arena-sanitized" };
const MAX_BUFFERED_SPANS = 32;
const MAX_EXPORT_BATCH = 16;
const DROP_SIGNAL_EVERY = 32;

export type StructuredSpanReadiness = { ready: boolean; queued: number; dropped: number; reason?: "unsupported_protocol" | "invalid_endpoint" | "invalid_headers" | "log_unacknowledged" };

let structuredReadiness: StructuredSpanReadiness = { ready: true, queued: 0, dropped: 0 };

export function structuredSpanReadiness(): StructuredSpanReadiness {
  return { ...structuredReadiness };
}

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
        const acknowledged = context.with(ROOT_CONTEXT, () => log("info", "trace.span", {
          trace_id: spanContext.traceId,
          span_id: spanContext.spanId,
          ...(span.parentSpanContext?.spanId ? { parent_span_id: span.parentSpanContext.spanId } : {}),
          span_name: span.name,
          span_kind: span.kind,
          span_status: span.status.code,
          ...span.attributes,
        }));
        if (!acknowledged) throw new Error("structured span retention was not acknowledged");
      }
      callback({ code: 0 });
    } catch (error) {
      structuredReadiness = { ...structuredReadiness, ready: false, reason: "log_unacknowledged" };
      callback({ code: 1, error: error instanceof Error ? error : new Error("structured span export failed") });
    }
  }
  forceFlush(): Promise<void> { return Promise.resolve(); }
  shutdown(): Promise<void> { return Promise.resolve(); }
}

function parseHeaders(value: string | undefined): Record<string, string> | null {
  if (!value?.trim()) return {};
  const headers: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const delimiter = entry.indexOf("=");
    if (delimiter < 1) return null;
    const key = entry.slice(0, delimiter).trim();
    const headerValue = entry.slice(delimiter + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || !headerValue || /[\r\n]/.test(headerValue)) return null;
    headers[key] = headerValue;
  }
  return headers;
}

type CollectorConfiguration = { url: string; headers: Record<string, string>; protocol: "http/protobuf" | "http/json" } | { reason: "unsupported_protocol" | "invalid_endpoint" | "invalid_headers" } | null;

function configuredCollector(): CollectorConfiguration {
  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const endpoint = tracesEndpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/$/, "");
  const url = tracesEndpoint ? tracesEndpoint : endpoint ? `${endpoint}/v1/traces` : null;
  const protocol = process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL?.trim() || process.env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim() || "http/protobuf";
  const generalHeaders = parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
  const traceHeaders = parseHeaders(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS);
  const headers = generalHeaders && traceHeaders ? { ...generalHeaders, ...traceHeaders } : null;
  if (url) {
    if (protocol !== "http/protobuf" && protocol !== "http/json") return { reason: "unsupported_protocol" };
    if (!headers) return { reason: "invalid_headers" };
    try {
      const parsed = new URL(url);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return { reason: "invalid_endpoint" };
    } catch { return { reason: "invalid_endpoint" }; }
    return { url, headers, protocol };
  }
  if (!process.env.VERCEL_OTEL_ENDPOINTS) return null;
  const vercelProtocol = process.env.VERCEL_OTEL_ENDPOINTS_PROTOCOL?.trim() || "http/protobuf";
  if (vercelProtocol !== "http/protobuf") return { reason: "unsupported_protocol" };
  const rawPort = process.env.VERCEL_OTEL_ENDPOINTS_PORT?.trim() || "4318";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { reason: "invalid_endpoint" };
  return { url: `http://localhost:${port}/v1/traces`, headers: {}, protocol: "http/protobuf" };
}

function shouldRetainSpan(span: ReadableSpan): boolean {
  return !span.parentSpanContext || span.kind === SpanKind.SERVER || span.status.code === SpanStatusCode.ERROR;
}

/** Bounded, flushable processor: automatic child spans never synchronously write logs. */
export class BoundedSpanProcessor implements SpanProcessor {
  private queue: ReadableSpan[] = [];
  private dropped = 0;
  private closed = false;
  constructor(private readonly exporter: SpanExporter) {}
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    if (this.closed || !shouldRetainSpan(span)) return;
    if (this.queue.length >= MAX_BUFFERED_SPANS) {
      this.dropped += 1;
      structuredReadiness = { ...structuredReadiness, queued: this.queue.length, dropped: structuredReadiness.dropped + 1 };
      if (this.dropped % DROP_SIGNAL_EVERY === 1) log("warn", "trace.span_dropped", { reason: "queue_full", dropped: this.dropped });
      return;
    }
    this.queue.push(span);
    structuredReadiness = { ...structuredReadiness, queued: this.queue.length };
  }
  async forceFlush(): Promise<void> {
    while (this.queue.length) {
      const batch = this.queue.splice(0, MAX_EXPORT_BATCH).map(safeExportSpan);
      structuredReadiness = { ...structuredReadiness, queued: this.queue.length };
      await new Promise<void>((resolve, reject) => this.exporter.export(batch, (result) => {
        if (result.code === 0) {
          structuredReadiness = { ...structuredReadiness, ready: true, reason: undefined };
          resolve();
        }
        else reject(result.error ?? new Error("span exporter did not acknowledge retention"));
      }));
    }
  }
  async shutdown(): Promise<void> { this.closed = true; await this.forceFlush(); await this.exporter.shutdown(); }
}

/** Uses the supported onEnd/export lifecycle; readonly SDK spans are never mutated. */
export function createSafeSpanProcessor(exporter: SpanExporter = new StructuredSpanExporter()): SpanProcessor {
  return new BoundedSpanProcessor(new SafeSpanExporter(exporter));
}

/**
 * Runtime logs are the always-on trace sink. OTLP is additive only when the
 * environment proves a collector exists, avoiding silent localhost export.
 */
export function createSafeSpanProcessors(): SpanProcessor[] {
  const processors: SpanProcessor[] = [createSafeSpanProcessor()];
  const collector = configuredCollector();
  if (collector && "reason" in collector) {
    structuredReadiness = { ...structuredReadiness, ready: false, reason: collector.reason };
    return processors;
  }
  if (collector) {
    const exporter = collector.protocol === "http/json"
      ? new OTLPHttpJsonTraceExporter({ url: collector.url, headers: collector.headers })
      : new OTLPHttpProtoTraceExporter({ url: collector.url, headers: collector.headers });
    processors.push(createSafeSpanProcessor(exporter));
  }
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
