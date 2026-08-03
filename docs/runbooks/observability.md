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
event with the deployment under investigation. Trace availability and retention
are plan/provider dependent: Vercel-native telemetry is the source of truth,
and a missing trace is not proof that an application event did not occur.

For an error, begin with `request.error`, then follow the trace/span fields to
storage, sandbox, dispatch, provider, callback, or cron events. Route-level
events deliberately record stage and status instead of raw request/provider
payloads. If a suspected secret appears, stop sharing logs, rotate that secret,
and search only with an approved Vercel access path.

## Local behavior

`instrumentation.ts` registers `@vercel/otel`; a local collector/back end is
required to view exported traces. Set `NEXT_OTEL_VERBOSE=1` only when the extra
Next spans are useful. Without a collector, JSON logs still work and simply omit
trace/span IDs when no active span is exposed.

## Rollback

In the isolated development project, roll back to the previous development
deployment or revert the observability commit. Never use this runbook to alter
or roll back production. Do not disable redaction to debug an incident.
Do not disable redaction to debug an incident. The logger is intentionally
best-effort and synchronous to avoid making telemetry failures alter request
outcomes; inspect the deployment/runtime error separately if log delivery is
unavailable.
