import { JsonTraceSerializer, ProtobufTraceSerializer, type ISerializer } from "@opentelemetry/otlp-transformer";
import { waitUntil } from "@vercel/functions";
import { registerOTel } from "@vercel/otel";
import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, type Attributes, type SpanContext, type SpanStatus } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { type ReadableSpan, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Instrumentation } from "next";
import { log, normalizeError } from "./lib/log";
import { assertOpsReadCredentialSeparation } from "./lib/credential-separation.mjs";

const SAFE_RESOURCE = resourceFromAttributes({ "service.name": "harness-arena" });
const SAFE_SCOPE = { name: "harness-arena-sanitized" };
const MAX_BUFFERED_SPANS = 32;
const MAX_EXPORT_BATCH = 16;
const DROP_SIGNAL_EVERY = 32;
const EXPORT_ACK_DEADLINE_MILLIS = 5_000;
const MAX_RETAINED_EXPORT_BATCHES = Math.ceil(MAX_BUFFERED_SPANS / MAX_EXPORT_BATCH);
// A full retained queue can begin draining while the request is still ending.
// Once its first batch is acknowledged, one more full batch can arrive before
// the next acknowledgement frees the in-flight slots. Keep that late batch in
// the request lifetime too, but retain a fixed derived upper bound.
const MAX_POST_ROOT_DRAIN_BATCHES = MAX_RETAINED_EXPORT_BATCHES + 1;
const POST_ROOT_DRAIN_DEADLINE_MILLIS = MAX_POST_ROOT_DRAIN_BATCHES * EXPORT_ACK_DEADLINE_MILLIS + 250;
const OTLP_REQUEST_DEADLINE_MILLIS = 4_000;

type ReadinessReason = "unsupported_protocol" | "invalid_endpoint" | "invalid_headers" | "log_unacknowledged" | "export_unacknowledged";
type SinkReadiness = { configured: boolean; ready: boolean; queued: number; dropped: number; reason?: ReadinessReason };
export type StructuredSpanReadiness = SinkReadiness & { structured: SinkReadiness; otlp: SinkReadiness };

let structuredReadiness: StructuredSpanReadiness = createReadiness();

function createReadiness(): StructuredSpanReadiness {
  const structured: SinkReadiness = { configured: true, ready: true, queued: 0, dropped: 0 };
  const otlp: SinkReadiness = { configured: false, ready: true, queued: 0, dropped: 0 };
  return { ...structured, structured, otlp };
}

function emitSinkStateTransition(sink: "structured" | "otlp", state: "degraded" | "ready", readiness: SinkReadiness): void {
  context.with(ROOT_CONTEXT, () => log(state === "degraded" ? "warn" : "info", "trace.sink_state", {
    sink,
    state,
    ...(state === "degraded" && readiness.reason ? { reason: readiness.reason } : {}),
    queued: readiness.queued,
    dropped: readiness.dropped,
  }));
}

function updateSinkReadiness(sink: "structured" | "otlp", changes: Partial<SinkReadiness>): void {
  const previousSink = structuredReadiness[sink];
  const nextSink = { ...previousSink, ...changes };
  const structured = sink === "structured" ? nextSink : structuredReadiness.structured;
  const otlp = sink === "otlp" ? nextSink : structuredReadiness.otlp;
  const ready = structured.ready && (!otlp.configured || otlp.ready);
  const reason = !structured.ready ? structured.reason : !otlp.ready ? otlp.reason : undefined;
  structuredReadiness = {
    configured: structured.configured,
    ready,
    queued: structured.queued + otlp.queued,
    dropped: structured.dropped + otlp.dropped,
    ...(reason ? { reason } : {}),
    structured,
    otlp,
  };
  const previousFailure = previousSink.configured && !previousSink.ready ? previousSink.reason : undefined;
  const nextFailure = nextSink.configured && !nextSink.ready ? nextSink.reason : undefined;
  if (nextFailure && nextFailure !== previousFailure) emitSinkStateTransition(sink, "degraded", nextSink);
  else if (previousFailure && nextSink.configured && nextSink.ready) emitSinkStateTransition(sink, "ready", nextSink);
}

export function structuredSpanReadiness(): StructuredSpanReadiness {
  return {
    ...structuredReadiness,
    structured: { ...structuredReadiness.structured },
    otlp: { ...structuredReadiness.otlp },
  };
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

type TraceSerializer = ISerializer<ReadableSpan[], unknown>;

/** Status-aware OTLP transport that never interprets or logs collector data. */
export class SanitizedOtlpHttpExporter implements SpanExporter {
  private readonly pending = new Set<Promise<void>>();
  private closed = false;
  private readonly serializer: TraceSerializer;
  private readonly contentType: "application/json" | "application/x-protobuf";

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    protocol: "http/json" | "http/protobuf",
  ) {
    this.serializer = protocol === "http/json" ? JsonTraceSerializer : ProtobufTraceSerializer;
    this.contentType = protocol === "http/json" ? "application/json" : "application/x-protobuf";
  }

  export(spans: ReadableSpan[], callback: Parameters<SpanExporter["export"]>[1]): void {
    let callbackCalled = false;
    const complete = (result: Parameters<typeof callback>[0]) => {
      if (callbackCalled) return;
      callbackCalled = true;
      callback(result);
    };
    if (this.closed) {
      complete({ code: 1, error: new Error("OTLP collector did not acknowledge export") });
      return;
    }
    const task = this.send(spans)
      .then(
        () => complete({ code: 0 }),
        () => complete({ code: 1, error: new Error("OTLP collector did not acknowledge export") }),
      )
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
  }

  private async send(spans: ReadableSpan[]): Promise<void> {
    const body = this.serializer.serializeRequest(spans);
    if (!body) throw new Error("OTLP request serialization failed");
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const requestDeadline = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        controller.abort();
        reject(new Error("OTLP request deadline exceeded"));
      }, OTLP_REQUEST_DEADLINE_MILLIS);
    });
    try {
      const request = fetch(this.url, {
        method: "POST",
        body: body as BodyInit,
        headers: { ...this.headers, accept: this.contentType, "content-type": this.contentType },
        signal: controller.signal,
        // Prevent this telemetry request from producing another traced request.
        // @ts-expect-error Next.js extends RequestInit with this internal marker.
        next: { internal: true },
      });
      const response = await Promise.race([request, requestDeadline]);
      // Collector bodies can contain arbitrary provider-controlled data. Cancel
      // and discard without parsing, retaining, or passing them to diagnostics.
      void response.body?.cancel().catch(() => undefined);
      if (response.status < 200 || response.status > 299) throw new Error("OTLP collector rejected export");
    } catch {
      throw new Error("OTLP collector did not acknowledge export");
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  async forceFlush(): Promise<void> { await Promise.all([...this.pending]); }
  async shutdown(): Promise<void> { this.closed = true; await this.forceFlush(); }
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
      updateSinkReadiness("structured", { ready: false, reason: "log_unacknowledged" });
      callback({ code: 1, error: error instanceof Error ? error : new Error("structured span export failed") });
    }
  }
  forceFlush(): Promise<void> { return Promise.resolve(); }
  shutdown(): Promise<void> { return Promise.resolve(); }
}

export function parseOtlpHeaders(value: string | undefined): Record<string, string> | null {
  if (!value?.trim()) return {};
  const headers: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const delimiter = entry.indexOf("=");
    if (delimiter < 1) return null;
    const key = entry.slice(0, delimiter).trim();
    const encodedValue = entry.slice(delimiter + 1).trim();
    let headerValue: string;
    try { headerValue = decodeURIComponent(encodedValue); } catch { return null; }
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || !headerValue || /[\u0000-\u001F\u007F]/.test(headerValue)) return null;
    // HTTP field names are case-insensitive. Canonicalizing before the
    // general/trace-specific merge makes the latter replace the former and
    // lets protocol-owned content headers replace any configured casing.
    headers[key.toLowerCase()] = headerValue;
  }
  return headers;
}

type CollectorConfiguration = { url: string; headers: Record<string, string>; protocol: "http/protobuf" | "http/json" } | { reason: "unsupported_protocol" | "invalid_endpoint" | "invalid_headers" } | null;

function configuredCollector(): CollectorConfiguration {
  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const endpoint = tracesEndpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/$/, "");
  const url = tracesEndpoint ? tracesEndpoint : endpoint ? `${endpoint}/v1/traces` : null;
  const protocol = process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL?.trim() || process.env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim() || "http/protobuf";
  const generalHeaders = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
  const traceHeaders = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS);
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
  return spanPriority(span) > 0;
}

function spanPriority(span: ReadableSpan): number {
  // A propagated remote parent has no local span to retain. Its direct local
  // child is therefore this process's request root, even though it has a
  // parentSpanContext.
  if (!span.parentSpanContext || span.parentSpanContext.isRemote) return 2;
  if (span.kind === SpanKind.SERVER || span.status.code === SpanStatusCode.ERROR) return 1;
  return 0;
}

type RootDrainParticipant = { forceFlush(): Promise<void> };
type RootDrainRegistration = { participants: Set<RootDrainParticipant> };
const rootDrainRegistrations = new Map<string, RootDrainRegistration>();

function registerPostRootDrain(rootKey: string, participant: RootDrainParticipant): void {
  const existing = rootDrainRegistrations.get(rootKey);
  if (existing) {
    existing.participants.add(participant);
    return;
  }

  const registration: RootDrainRegistration = { participants: new Set([participant]) };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const aggregate = Promise.resolve().then(async () => {
    // Composite processors call onEnd synchronously. Deferring one microtask
    // lets every configured sink join this root's single lifecycle task.
    await Promise.allSettled([...registration.participants].map((processor) => processor.forceFlush()));
  });
  const bounded = Promise.race([
    aggregate,
    new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("post-root span drain deadline exceeded")), POST_ROOT_DRAIN_DEADLINE_MILLIS);
    }),
  ]).then(
    () => undefined,
    () => undefined,
  ).finally(() => {
    if (deadline) clearTimeout(deadline);
    if (rootDrainRegistrations.get(rootKey) === registration) rootDrainRegistrations.delete(rootKey);
  });
  rootDrainRegistrations.set(rootKey, registration);
  try {
    // This synchronous call binds the aggregate promise to the current root's
    // Vercel request context. With no hosted context, the bounded task still
    // runs locally as a catch-wrapped best-effort fallback.
    waitUntil(bounded);
  } catch {
    // The local task is already running and cannot reject.
  }
}

/** Bounded, flushable processor: automatic child spans never synchronously write logs. */
export class BoundedSpanProcessor implements SpanProcessor {
  private queue: ReadableSpan[] = [];
  private dropped = 0;
  private closed = false;
  private flushInFlight?: Promise<void>;
  private inFlightBatchLength = 0;
  constructor(private readonly exporter: SpanExporter, private readonly sink: "structured" | "otlp" = "structured") {
    if (sink === "otlp") updateSinkReadiness("otlp", { configured: true });
  }
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    if (this.closed || !shouldRetainSpan(span)) return;
    if (this.queue.length >= MAX_BUFFERED_SPANS) {
      const priority = spanPriority(span);
      const evictionIndex = this.queue.findIndex((queued, index) => index >= this.inFlightBatchLength && spanPriority(queued) < priority);
      if (evictionIndex >= 0) {
        this.queue.splice(evictionIndex, 1);
        this.recordDrop("priority_evicted");
      } else {
        this.recordDrop("queue_full");
        return;
      }
    }
    this.queue.push(span);
    updateSinkReadiness(this.sink, { queued: this.queue.length });
    if (spanPriority(span) === 2) {
      const spanContext = span.spanContext();
      registerPostRootDrain(`${spanContext.traceId}:${spanContext.spanId}`, this);
    }
  }
  private recordDrop(reason: "queue_full" | "priority_evicted"): void {
    this.dropped += 1;
    const sinkReadiness = structuredReadiness[this.sink];
    updateSinkReadiness(this.sink, { queued: this.queue.length, dropped: sinkReadiness.dropped + 1 });
    if (this.dropped % DROP_SIGNAL_EVERY === 1) log("warn", "trace.span_dropped", { sink: this.sink, reason, dropped: this.dropped });
  }
  private async drain(): Promise<void> {
    while (this.queue.length) {
      // Keep a batch in the bounded queue until the exporter acknowledges it.
      // A rejected flush returns to Vercel's waitUntil lifecycle rather than
      // spinning, and the next request/shutdown may retry the same spans.
      const batchLength = Math.min(this.queue.length, MAX_EXPORT_BATCH);
      this.inFlightBatchLength = batchLength;
      const batch = this.queue.slice(0, batchLength).map(safeExportSpan);
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (completion: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            completion();
          };
          const deadline = setTimeout(() => {
            settle(() => reject(new Error("span exporter acknowledgement deadline exceeded")));
          }, EXPORT_ACK_DEADLINE_MILLIS);
          try {
            this.exporter.export(batch, (result) => {
              if (result.code === 0) settle(resolve);
              else settle(() => reject(result.error ?? new Error("span exporter did not acknowledge retention")));
            });
          } catch (error) {
            settle(() => reject(error));
          }
        });
      } catch (error) {
        this.inFlightBatchLength = 0;
        // The structured exporter already records its more specific failure
        // reason before it reports the failed export result. Keep that single
        // transition instead of overwriting it with the generic processor one.
        const reason = structuredReadiness[this.sink].reason ?? "export_unacknowledged";
        updateSinkReadiness(this.sink, { ready: false, queued: this.queue.length, reason });
        throw error;
      }
      this.queue.splice(0, batchLength);
      this.inFlightBatchLength = 0;
      updateSinkReadiness(this.sink, { ready: true, queued: this.queue.length, reason: undefined });
    }
  }
  async forceFlush(): Promise<void> {
    if (this.flushInFlight) {
      await this.flushInFlight;
      if (this.queue.length) await this.forceFlush();
      return;
    }
    const flush = this.drain();
    this.flushInFlight = flush;
    try { await flush; }
    finally {
      if (this.flushInFlight === flush) this.flushInFlight = undefined;
    }
    if (this.queue.length) await this.forceFlush();
  }
  async shutdown(): Promise<void> { this.closed = true; await this.forceFlush(); await this.exporter.shutdown(); }
}

/** Uses the supported onEnd/export lifecycle; readonly SDK spans are never mutated. */
export function createSafeSpanProcessor(exporter: SpanExporter = new StructuredSpanExporter(), sink: "structured" | "otlp" = "structured"): SpanProcessor {
  return new BoundedSpanProcessor(new SafeSpanExporter(exporter), sink);
}

/**
 * Runtime logs are the always-on trace sink. OTLP is additive only when the
 * environment proves a collector exists, avoiding silent localhost export.
 */
export function createSafeSpanProcessors(): SpanProcessor[] {
  const processors: SpanProcessor[] = [createSafeSpanProcessor()];
  const collector = configuredCollector();
  if (collector && "reason" in collector) {
    updateSinkReadiness("otlp", { configured: true, ready: false, queued: 0, dropped: 0, reason: collector.reason });
    return processors;
  }
  if (collector) {
    updateSinkReadiness("otlp", { configured: true, ready: true, queued: 0, dropped: 0, reason: undefined });
    const exporter = new SanitizedOtlpHttpExporter(collector.url, collector.headers, collector.protocol);
    processors.push(createSafeSpanProcessor(exporter, "otlp"));
  } else {
    updateSinkReadiness("otlp", { configured: false, ready: true, queued: 0, dropped: 0, reason: undefined });
  }
  return processors;
}

export function register() {
  assertOpsReadCredentialSeparation(process.env);
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
