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
root/server/error spans, caps the pending queue at 32 spans and batches at 16;
automatic child spans therefore cannot synchronously flood runtime logs.
`trace.span_dropped` is rate-limited and the safe `structuredSpanReadiness()`
surface exposes aggregate and sink-specific (`structured` and `otlp`) queued/
dropped counts and an unready reason without collector headers or their values.
The OTLP queue retains a failed batch until a later request or shutdown flush
acknowledges it; it remains capped at 32 spans, records
`export_unacknowledged`, and does not loop inside a single `forceFlush` call.
Vercel's supported request context registers flush work with `waitUntil`, so a
normal request can drain the bounded queue before function termination.

`structuredSpanReadiness()` is process-local diagnostic state, not evidence of
cross-instance or cross-lambda health. Establish hosted health from the
redacted structured runtime logs and the collector's own receipt/metrics across
the deployment being investigated. A successful structured log sink cannot
clear an invalid or failed optional OTLP sink; OTLP is truthfully degraded while
the structured source-of-truth remains available.

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
