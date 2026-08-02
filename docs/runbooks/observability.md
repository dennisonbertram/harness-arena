# Observability runbook

Harness Arena emits one redacted JSON line per domain event. The envelope has
`ts`, `level`, `event`, `environment`, `deployment_sha`, and, when Next has an
active OpenTelemetry span, `trace_id` and `span_id`. Domain events add stable
identifiers such as `run_id` and `submission_id`; they never add request bodies,
headers, cookies, prompts, credentials, provider tokens, or Blob query strings.

## Delivery dependency and proof status

This change explicitly depends on PR #171 for `/api/ops/v1`. Until #171 lands,
this PR must remain draft: it does not contain or claim ops-endpoint logging.
After #171 merges, rebase this branch and add tested `/api/ops/v1` domain events
before requesting final review. Production trace/redaction proof is also pending;
local and preview evidence must not be described as live production proof.

## Vercel investigation

Start from the deployment serving the hostname, then query its logs with the
Vercel CLI. Filter JSON messages by `event`, `run_id`, or `trace_id`; compare
the deployment SHA in each event with the deployment under investigation. Trace
availability and Vercel retention are plan/provider dependent: Vercel-native
telemetry is the source of truth, and a missing trace is not proof that an
application event did not occur. PostHog is not configured or claimed live.

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

Roll back to the previous Vercel deployment or revert the observability commit.
Do not disable redaction to debug an incident. The logger is intentionally
best-effort and synchronous to avoid making telemetry failures alter request
outcomes; inspect the deployment/runtime error separately if log delivery is
unavailable.
