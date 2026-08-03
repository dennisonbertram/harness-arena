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
When `VERCEL_READ_TOKEN` is configured, the monitor uses only authenticated
GETs to Vercel deployment metadata, project environment metadata (never with
decryption), and deployment runtime-log endpoints. It retains variable names
and error counts only; it never retains environment values, log text, or the
token. Missing credentials, 401/403 responses, malformed metadata, and
unavailable endpoints are `access_blocked`. Unobserved environment variables,
runtime logs, cron configuration, and deployment identity remain explicitly
unknown; the monitor does not manufacture missing variables, an empty error
list, or a ready deployment. HTTP 200 bodies are still untrusted: only the
documented environment containers, typed entries and targets, and runtime-log
singleton/array/data containers with valid entries become observed evidence;
malformed containers or any malformed entry remain unknown and add
`platform_evidence_invalid`. The stable requested alias is retained separately
from Vercel's returned unique deployment URL, and deployment evidence is
accepted only when the deployment ID, project ID, and alias all match the fixed
target. `expected_sha` remains unknown unless a future independent GET supplies
the expected ref; runtime `VERCEL_GIT_COMMIT_SHA` is not independent evidence.
The full two-environment collection has a twelve-second route-wide deadline,
below the route's fifteen-second `maxDuration`. The inventory work is bounded to
20 advertised kinds, 10 pages per kind, 100 records per page, and 20 correlated
runs; the global deadline aborts outstanding probes before those worst-case
loops can consume the function lifetime.

Each successful invocation emits one sanitized `monitor.observation` record for
each fixed environment. Records contain the timestamp, environment, verdict,
deployment SHA when available, allowlisted failing-check codes, and safe
correlation IDs. The shared logger adds active OpenTelemetry `trace_id` and
`span_id` fields. Product health failures use `product_failure`; collector,
guard, or telemetry failures use `monitor_self_failure`. Missing application or
production platform read access is explicit `access_blocked`, never inferred as
healthy.
Malformed or internally inconsistent collector results are monitor failures,
not product failures. A missing or incorrect cron bearer returns a quiet bounded
401 without emitting an observation, so unauthenticated traffic cannot flood the
retained evidence stream. If the logger cannot acknowledge emission, the route
returns 503 because logs and their OpenTelemetry correlation are the sole
retained monitor evidence.

Before enabling the isolated schedule, provision `CRON_SECRET`,
`DEVELOPMENT_OPS_READ_TOKEN`, `PRODUCTION_OPS_READ_TOKEN`, and a distinct
read-only `VERCEL_READ_TOKEN` in the Development project. The two ops tokens
and Vercel token must be independently scoped GET-only credentials. All four
secrets must be distinct; hashed constant-time comparisons fail closed before
probes if any configured values collide.
The route explicitly hands the collector only these four credentials plus the
`VERCEL_PROJECT_ID` and `VERCEL_ENV` guard fields; it never passes the ambient
environment object. Access inventory diagnostics report presence metadata only
and never print, write, or retain any of the four secret values.
Do not copy, print, rotate, or inspect a live write credential.

After the separate Development deployment exists, invoke the route with its
cron bearer and inspect that deployment's Vercel logs for both target-scoped
`monitor.observation` records and their trace/deployment correlation. Also prove
that missing auth, a wrong project, a redirect, and a missing read token fail
closed. Production validation is passive only.

Rollback is removing the single cron entry from the Development project or
removing its isolated `CRON_SECRET`. This monitor does not modify application
data, deployments, provider state, repository state, or production settings.
