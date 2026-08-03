# Observability runbook

Harness Arena emits one redacted JSON line per domain event. The envelope has
`ts`, `level`, `event`, `environment`, `deployment_sha`, and, when Next has an
active OpenTelemetry span, `trace_id` and `span_id`. Domain events add stable
identifiers such as `run_id` and `submission_id`; they never add request bodies,
headers, cookies, prompts, credentials, provider tokens, or Blob query strings.

## Development-only delivery boundary

This integration is development-only. It may be tested only against the protected
development branch and the isolated `harness-arena-development` Vercel project.
Do not deploy this work to production, change production Vercel configuration,
alter production environment variables, or mutate production project settings.
Local and isolated-development evidence must never be described as production proof.

## Vercel investigation

For the isolated development project only, start from the deployment serving its
development hostname, then query its logs with the Vercel CLI. Filter JSON
messages by `event`, `run_id`, or `trace_id`; compare the deployment SHA in each
event with the deployment under investigation. Root/server/error spans are
exported as redacted `trace.span` JSON events, so agents retain a queryable trace
path even when no OTLP collector is configured. An explicitly configured OTLP
collector is an additive sink, not the only copy.

For an error, begin with `request.error`, then follow the trace/span fields to
storage, sandbox, dispatch, provider, callback, or cron events. Route-level
events deliberately record stage and status instead of raw request/provider
payloads. If a suspected secret appears, stop sharing logs, rotate that secret,
and search only with an approved Vercel access path.

## Local behavior

`instrumentation.ts` disables `@vercel/otel`'s automatic exporters so every
retained span crosses the safe-clone boundary. A flushable queue retains only
root/server/error spans, caps the pending queue at 32 spans and batches at 16.
Roots have higher admission priority than retained server/error children, so a
root that ends last evicts one lower-priority, non-exporting child from a full
queue. The in-flight export prefix is never mutated. If every eligible entry is
equal or higher priority, the arriving span can still be dropped; the queue
never exceeds 32 and every rejection or eviction increments drop accounting.
Automatic child spans therefore cannot synchronously flood runtime logs.
`trace.span_dropped` is rate-limited and the safe `structuredSpanReadiness()`
surface exposes aggregate and sink-specific (`structured` and `otlp`) queued/
dropped counts and an unready reason without collector headers or their values.
The OTLP queue retains a failed batch until a later request or shutdown flush
acknowledges it; it remains capped at 32 spans, records
`export_unacknowledged`, and does not loop inside a single `forceFlush` call.
Because `@vercel/otel`'s root-start lifecycle wait is short, every accepted
retained span synchronously registers a post-enqueue task through the public
`@vercel/functions` `waitUntil` API in its current request context. Structured
and OTLP processors coalesce on that span's exact `trace_id:span_id` identity,
so multiple sinks share one promise without combining distinct spans or
requests. Each promise seals a fixed queue-sequence cutoff on the next
microtask. Spans ending in the same turn keep independent lifecycle ownership
while sharing a bounded processor drain; later spans register new promises.
The per-span lifecycle deadline is derived from queue capacity and the per-export
acknowledgement bound. Because older generation cutoffs can split
otherwise combinable batches, the sound worst case is one five-second export
window for each of the 32 bounded queue slots, plus a 250 ms settlement margin.
New arrivals never extend an existing generation or create an unbounded
recursive drain. Failures are consumed by the lifecycle task while
the unacknowledged batch remains queued for a later request or shutdown retry.
No parent/root ancestry cache is involved: saved ended-parent contexts, active
descendants, cap pressure, and elapsed time cannot cause an accepted retained
span to lose lifecycle ownership. Spans refused by the bounded queue increment
the sink's dropped count and emit the rate-limited safe drop signal; they are
never enqueued as unowned work.
Without a hosted request context, the same bounded, catch-wrapped task runs
locally as a best-effort fallback.

`structuredSpanReadiness()` is process-local diagnostic state, not evidence of
cross-instance or cross-lambda health. Establish hosted health from the
redacted structured runtime logs and the collector's own receipt/metrics across
the deployment being investigated. A successful structured log sink cannot
clear an invalid or failed optional OTLP sink; OTLP is truthfully degraded while
the structured source-of-truth remains available.

Configuration/export degradation and recovery transitions also emit sanitized
`trace.sink_state` runtime-log events. They contain only `sink`, `state`, a safe
enumerated `reason` when degraded, and numeric `queued`/`dropped` counts. Queue
count changes do not emit events, and an unchanged state/reason is deduplicated.
These events are process-local hosted clues to correlate across deployment logs,
not proof that another lambda or the whole deployment is healthy.

OTLP is enabled only for an explicit `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or
`OTEL_EXPORTER_OTLP_ENDPOINT`, or Vercel's discovered HTTP/protobuf collector.
The trace-specific `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`/`_HEADERS` override
their general `OTEL_EXPORTER_OTLP_PROTOCOL`/`_HEADERS` counterparts; supported
protocols are `http/protobuf` and `http/json`. Invalid endpoints or headers and
unsupported protocols fail closed before a request is sent. Header values must
never be printed, copied into diagnostics, or pasted into an incident.
Standard percent-encoded OTLP header values are decoded exactly before export;
malformed encodings or decoded control characters fail closed and are never
logged.

## Rollback

In the isolated development project, roll back to the previous development
deployment or revert the observability commit. Never use this runbook to alter
or roll back production. Do not disable redaction to debug an incident.
The logger is intentionally best-effort and synchronous to avoid making telemetry
failures alter request outcomes; inspect the deployment/runtime error separately
if log delivery is unavailable.
