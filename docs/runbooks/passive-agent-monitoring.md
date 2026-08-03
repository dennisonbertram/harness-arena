# Passive agent monitoring

The only scheduled monitor runs in the isolated Development Vercel project
`harness-arena-development` (`prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA`). At minute
17 and 47, Vercel Cron sends an authenticated GET to
`/api/cron/agent-monitor`. The route fails closed unless the immutable runtime
project ID is exact, `VERCEL_ENV=production` for that project, the request uses
the canonical `https://harness-arena-development.vercel.app` origin, and the
bearer value exactly matches a 32-byte-or-longer `CRON_SECRET`.

The collector has two fixed application targets:

- Development: `https://harness-arena-development.vercel.app`, authenticated
  with `DEVELOPMENT_OPS_READ_TOKEN`.
- Production: `https://harness-arena-psi.vercel.app`, authenticated with the
  separately scoped `PRODUCTION_OPS_READ_TOKEN`.

Only GET requests to the health and `/api/ops/v1` read surfaces are permitted.
Redirects are rejected. The reused status collector bounds each request to five
seconds, bounds response bodies, inventory pages, advertised kinds, and run
correlations, and redacts read tokens. There is no configurable URL, GitHub
credential, Blob/admin/deployment credential, write API, or mutation path.

Each successful invocation emits one sanitized `monitor.observation` record for
each fixed environment. Records contain the timestamp, environment, verdict,
deployment SHA when available, allowlisted failing-check codes, and safe
correlation IDs. The shared logger adds active OpenTelemetry `trace_id` and
`span_id` fields. Product health failures use `product_failure`; collector,
guard, or telemetry failures use `monitor_self_failure`. Missing application or
production platform read access is explicit `access_blocked`, never inferred as
healthy.

Before enabling the isolated schedule, provision only `CRON_SECRET`,
`DEVELOPMENT_OPS_READ_TOKEN`, and `PRODUCTION_OPS_READ_TOKEN` in the Development
project. The two ops tokens must be independently scoped GET-only credentials.
Do not copy, print, rotate, or inspect a live write credential.

After the separate Development deployment exists, invoke the route with its
cron bearer and inspect that deployment's Vercel logs for both target-scoped
`monitor.observation` records and their trace/deployment correlation. Also prove
that missing auth, a wrong project, a redirect, and a missing read token fail
closed. Production validation is passive only.

Rollback is removing the single cron entry from the Development project or
removing its isolated `CRON_SECRET`. This monitor does not modify application
data, deployments, provider state, repository state, or production settings.
