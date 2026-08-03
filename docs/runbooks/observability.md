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
event with the deployment under investigation. Every ended OpenTelemetry span is
also exported as a redacted `trace.span` JSON event, so agents retain a queryable
trace path even when no OTLP collector is configured. An explicitly configured
OTLP collector is an additive sink, not the only copy.

For an error, begin with `request.error`, then follow the trace/span fields to
storage, sandbox, dispatch, provider, callback, or cron events. Route-level
events deliberately record stage and status instead of raw request/provider
payloads. If a suspected secret appears, stop sharing logs, rotate that secret,
and search only with an approved Vercel access path.

## Local behavior

`instrumentation.ts` disables `@vercel/otel`'s automatic exporters so every span
crosses the safe-clone boundary. The always-on exporter writes bounded
`trace.span` JSON events to runtime logs. If `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
`OTEL_EXPORTER_OTLP_ENDPOINT`, or Vercel's HTTP/protobuf collector discovery
variables prove a collector exists, the same safe clone is additionally sent
through the official OTLP HTTP/protobuf exporter. Never re-enable an automatic
exporter as a debugging workaround because that bypasses the safe clone boundary.

## Rollback

In the isolated development project, roll back to the previous development
deployment or revert the observability commit. Never use this runbook to alter
or roll back production. Do not disable redaction to debug an incident.
The logger is intentionally best-effort and synchronous to avoid making telemetry
failures alter request outcomes; inspect the deployment/runtime error separately
if log delivery is unavailable.
