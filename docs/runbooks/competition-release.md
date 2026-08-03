# Competition Release Runbook

This is the production procedure for creating a versioned competition, proving
its baseline, admitting entrants, and publishing it on the homepage. Update the
release record while the work is happening; do not reconstruct it from memory
afterward.

## Release invariant

A competition is an immutable measurement target:

```text
{ arena, harness, task set, model, gateway provider }
```

Never change the model or provider behind an existing leaderboard. Create and
prove a successor first, then close the predecessor. Closing preserves its
entries and run history.

`provider_requested` records intent. `provider_pinned` and the per-task gateway
correlations record what actually happened. Intent alone is not comparable
benchmark evidence.

## 1. Identify production before changing anything

Use Vercel CLI early; the browser and repository are not production evidence.

```sh
vercel whoami --scope dennisons-projects
vercel inspect https://harness-arena-psi.vercel.app --scope dennisons-projects
vercel env ls production --scope dennisons-projects --format json
vercel logs <serving-deployment-url> --since 30m --no-follow
vercel curl /api/competitions -- --silent
vercel curl /api/competition/submissions -- --silent
```

Before declaring the deployment reproducible, verify the structured Git
metadata rather than treating `Ready` as sufficient. `vercel inspect --json`
does not include the Git metadata, so select the serving record from the
production-list response:

```sh
vercel ls --prod --format json > /tmp/harness-arena-deployments.json
jq '.deployments[0]' /tmp/harness-arena-deployments.json > /tmp/harness-arena-serving.json
node scripts/ops/check-deploy-provenance.mjs /tmp/harness-arena-serving.json \
  --branch main --sha "$(git rev-parse HEAD)"
```

The checker fails for a non-main branch, SHA mismatch, `gitDirty: "1"`, or
missing branch/SHA metadata. A missing `gitDirty` field is accepted because
Vercel's normal GitHub deployments omit it; it still must never be `"1"`.

Record:

- serving deployment ID, URL, commit, readiness, and aliases;
- live and closed competition records;
- queued/running runs;
- presence, but never values, of `AI_GATEWAY_API_KEY`,
  `COMPETITION_ADMIN_TOKEN`, `RUNNER_CALLBACK_SECRET`, and Blob configuration.

Vercel runtime logs contain platform metadata and application-emitted fields.
Request bodies, proxy translations, and provider stream details must come from
the structured run events and traces.

## 2. Prove the exact Gateway target

Query the live catalog; do not infer a provider slug from a model vendor name.

```sh
vercel ai-gateway models endpoints <model-slug> \
  --format json \
  --scope dennisons-projects
```

Record the exact model slug, upstream provider slugs, supported tool/reasoning
parameters, context/output limits, pricing, and query timestamp.

No-fallback routing is:

```json
{
  "providerOptions": {
    "gateway": {
      "only": ["provider-slug"]
    }
  }
}
```

The sidecar must inject this field into every model request. A configured
provider map is not proof that the request used it.

## 3. Prove Pi's transport before paying for a baseline

Vercel publishes different client base URLs:

- OpenAI-compatible clients use `https://ai-gateway.vercel.sh/v1` and append
  `/chat/completions`.
- Anthropic-compatible clients use `https://ai-gateway.vercel.sh` and append
  `/v1/messages`.

Pi's built-in model transport wins over a provider-level `api` setting unless
the model is explicitly upserted in `models.json`. Inspect the pinned Pi
agentkit or a live trace to learn the effective transport.

Required red-first tests:

```sh
pnpm exec vitest run scripts/runner/gateway-proxy.test.mjs
pnpm exec vitest run lib/competition-baseline.test.ts
```

Stop if a constructed request can become `/v1/v1/messages`, if the provider pin
is missing from the forwarded body, or if a verbose Pi subprocess is killed
when diagnostic capture reaches its bound.

## 4. Local release gates

For every fix, first run the focused regression against the unfixed code and
confirm the expected failure. Then require:

```sh
pnpm test
pnpm typecheck
pnpm exec eslint <changed-files>
pnpm build
git diff --check
```

For UI changes, run the app locally and use Agent Browser in a fresh named
session. Exercise the visible path, check browser errors and console output,
and inspect the local server log.

Do not proceed with an unexplained test retry. A known timing-sensitive test
may be rerun alone only after the first output has been diagnosed and recorded.

## 5. Rotate the competition admin token

`COMPETITION_ADMIN_TOKEN` is an application-owned random shared secret. It is
not a token issued by the Vercel website. Vercel stores it and injects it into
deployments.

Production environment mutation is not an approved operation. Stop and obtain
a separately reviewed, development-only policy; do not invoke raw Vercel
environment commands from this runbook.

Never print it, put it in an argument, save it to a project file, pull it back
from Vercel, or include it in this document. Environment changes apply only to
new deployments, so deploy before using the replacement.

## 6. Deploy and prove the serving alias

```sh
vercel inspect https://harness-arena-psi.vercel.app \
  --wait --scope dennisons-projects --format json
vercel logs <deployment-id-from-inspect> --since 10m --level error --no-follow
```

The deployment URL and production alias must resolve to the same ready
deployment. The runner bundle URL is commit-keyed; confirm the deployed commit
contains the intended runner bundle rather than relying on the stable asset
pathname.

Production deployment is not an approved operation. Resolve the authoritative
deployment ID from the production alias with structured `vercel inspect --format json`.

## 7. Create the successor before closing the predecessor

Pre-query `/api/competitions` and assert that the target does not already
exist. Competition creation has no idempotency key; after an ambiguous
transport result, query records before retrying.

Create with auto-baseline enabled (omit `skip_baseline`). Only after creation
succeeds, close the predecessor:

```text
POST /api/competition/admin
{"arena":"harness-arena","harness":"pi","model":"<model>","gateway_provider":"<provider>"}

POST /api/competition/admin/<predecessor-id>/close
```

Send `x-competition-admin-token` through a stdin-provided curl header rather
than exposing the value in process arguments.

Postconditions:

- the successor is `live` with the exact model and provider;
- the predecessor still exists with `status: "closed"` and `closed_at`;
- its submissions, runs, and leaderboard remain intact.

## 8. Baseline stop/go gate

Creation is not completion. The creation response contains the competition, not
the asynchronously created baseline run. Find the competition's baseline
submission, read its `run_id`, then poll its passive event feed through Vercel
CLI. Do not use `GET /api/runs` or `GET /api/runs/<id>` for monitoring: those
routes lazily dispatch or reap work.

```sh
vercel curl '/api/runs/<run-id>/events?since=0' -- --silent
```

Go only when all of these are true:

- run reached `completed` with all 16 tasks attempted;
- exact competition model is recorded;
- `provider_requested` and terminal `provider_pinned` both equal the configured
  provider;
- every attempted task has `task.gateway_correlation`;
- proxy requests use the exact model and pin;
- responses have successful status, nonzero body/chunks, timing fields, and no
  `stream_error`;
- Pi recorded real assistant/tool turns and output/cost evidence;
- verifier failures, if any, follow productive model work rather than an
  untouched workspace.

Stop immediately on:

- repeated 4xx/5xx, especially `/v1/v1/messages`;
- missing or mismatched provider pin;
- zero-turn or zero-output tasks;
- `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, unexpected Pi exit, or truncated
  mid-JSON output followed by verification;
- 200 response headers with no bytes/first token;
- missing correlations or mixed providers;
- failed/reaped run or an all-infrastructure “completed” run.

When a task has emitted only `task.started`, do not call it a provider stall
from elapsed time alone. Use the `run.sandbox_creating` event's sandbox name
with a read-only Vercel process check:

```sh
vercel sandbox exec --sudo --scope dennisons-projects <sandbox-name> ps
```

An active runner `timeout` + `pi` + task process means work is still in flight.
A provider stall requires the proxy timing/byte evidence described below.

Do not submit entrants while the baseline gate is red. After the vanilla
baseline passes, submit one custom-prompt canary and require at least one real
Gateway response, Pi turn, and verifier result before launching several
entrants. The vanilla baseline does not exercise Pi's custom system-prompt
request shape.

## 9. Failure classification and retry policy

These are infrastructure failures, not model scores:

- run status `failed` or `reaped`;
- every attempted task ended before productive output with
  `provider_error`, `provider_timeout`, `agent_timeout`, or
  `agent_process_error`;
- every attempted task has zero turns/output, unmeasured cost, and the verifier
  ran against an untouched workspace.

The retry classifier is intentionally narrow. A provider error after productive
turns remains visible for investigation and is not automatically erased.

Retry rules:

- preflight retries only transient 429/5xx inside bounded attempts;
- an infrastructure-invalid baseline may be retried through
  `POST /api/competition/admin/baseline`;
- a judge rejection requires explicit admin review;
- do not mutate a stored score to hide an incident;
- do not retry an ambiguous create POST without querying competitions first.

## 10. Admit entrants through the real product path

Use an authenticated GitHub browser session and the production submission UI.
Do not write entrant records directly to storage.

First submit one custom-prompt canary. Follow its first task through the
Gateway, Pi, and verifier boundaries. Only after that path is productive,
submit several unique prompts:

1. select the live competition;
2. submit a unique name and non-baseline prompt;
3. capture submission and run IDs;
4. verify the submission snapshots the competition model/provider;
5. follow each run's status, events, gateway correlations, and traces;
6. classify every failure using the baseline gate above.

Respect the production concurrency limit. A queue is expected; a run stuck at
`0/16` without task events is not.

## 11. Homepage publication

Verify with both production APIs and a fresh browser session:

- selector finds the live successor and the closed predecessor;
- live card shows arena, harness, model, provider, intermediary
  (`Vercel AI Gateway`), and status;
- baseline appears only after valid completion;
- entrants move from pending to the correct leaderboard;
- run detail shows model, pinned provider, and intermediary;
- closed competition remains searchable but accepts no submissions.

Fetch provider artwork from a first-party source, retain the source URL and
checksum, and add a focused render test. For Inkling Small, the asset is
`https://thinkingmachines.ai/images/apple-touch-icon.png`; the fetched 180×180
PNG has SHA-256
`ef907e01669290064ce1db3d7902203fb2786dc110d2c496a8a02ad912d32e7e`.

After the browser smoke, query Vercel logs again and confirm the original
failure signature is absent on the serving deployment.

## Incident signatures observed

### Double `/v1` path

```text
404 ... requested resource was not found: /v1/v1/messages
```

Cause: Pi's Anthropic transport appended `/v1/messages` to an OpenAI-style
`/v1` proxy base. Fix: preserve Pi's transport and give Anthropic-compatible
models the proxy origin.

### Verbose reasoning killed Pi

```text
Gateway status 200
real response ID
Pi JSON contained repeated growing thinking partials
stdout ended mid-JSON at the capture boundary
0 recorded turns, unmeasured cost, verifier ran anyway
```

Cause: `execFile` buffered stdout and killed Pi at `maxBuffer`. Fix: use
`spawn`, continuously drain stdout/stderr, retain only a bounded diagnostic
prefix, and surface unexpected Pi exits before verification.

### Provider stall

```text
HTTP 200 text/event-stream
no body bytes / no first token / no response ID
idle deadline reached
```

This is provider/gateway infrastructure evidence, not a failed task. Preserve
request ID, pin, byte counts, first-byte/idle timing, and retry evidence. See
`docs/provider-stream-failure-ab.md`.

### Custom prompt requests the context window as output

```text
HTTP 400 from Baseten through Vercel AI Gateway
Invalid request: max_tokens (~994,000) must be <= 262144
16/16 tasks labelled provider_error
0 Pi turns, 0 verifier events, $0 cost
```

Cause: Pi's custom system-prompt path derived `max_tokens` from Inkling's
roughly one-million-token context metadata, while the live Baseten route caps
output at 262,144 tokens. This is an application request-construction failure,
not random provider instability, even though the boundary label is
`provider_error`. Fix: enforce the model-specific output ceiling in the proxy,
the authoritative last hop before Vercel AI Gateway, while preserving smaller
requests. Release gate: a vanilla baseline plus one productive custom-prompt
canary.

### Catalog vs. live-validator discrepancy (verified 2026-07-31)

Both current Vercel catalog surfaces advertise a one-million-token output
limit for `thinkingmachines/inkling-small`. The Vercel CLI endpoint view uses
provider-oriented field names:

```sh
vercel ai-gateway models endpoints thinkingmachines/inkling-small \
  --format json --scope dennisons-projects \
  | jq '.endpoints[] | select(.provider_name == "baseten") \
    | {provider_name, context_length, max_completion_tokens}'
# {"provider_name":"baseten","context_length":1000000,
#  "max_completion_tokens":1000000}
```

The public OpenAI-compatible catalog expresses the same values with different
field names:

```sh
curl -fsS https://ai-gateway.vercel.sh/v1/models \
  | jq '.data[] | select(.id == "thinkingmachines/inkling-small") \
    | {id, context_window, max_tokens, supported_parameters}'
# {"id":"thinkingmachines/inkling-small","context_window":1000000,
#  "max_tokens":1000000,"supported_parameters":[...,"max_tokens",...]}
```

Thus the field names depend on the catalog surface, but both advertise
1,000,000. The persisted production event for failed run
`7bc65b8e-ff02-4270-a222-16043a8ee486` records the other side of the
discrepancy without exposing credentials:

```sh
curl -fsS \
  'https://harness-arena-psi.vercel.app/api/runs/7bc65b8e-ff02-4270-a222-16043a8ee486/events?since=0' \
  | jq '.[] | select(.type == "task.failed") | {seq, type, payload}'
# The public feed confirms the safe task/stage/duration projection. Provider
# bodies and internal request/response IDs remain available only to operators.
```

Thus a dynamic lookup of this catalog alone remains unsafe: it tells Pi that
one million output tokens are valid, while the sole live Baseten route rejects
anything above 262,144 before inference. Keep a verified route-specific output
ceiling in the model profile, feed it to Pi, and retain the proxy clamp as the
last-hop guard. Recheck the live catalog and custom-prompt canary after any
model/provider change; report this catalog-versus-validator mismatch to Vercel
with the sanitized run ID and error above.

### Local proxy tests hang at 15 seconds

If every localhost proxy test times out without reaching its assertions, first
run a minimal Node server bind. Codex's restricted shell can reject
`listen(0, "127.0.0.1")` with `EPERM`; Vitest then reports a misleading test
timeout. Re-run the suite with permission to open localhost sockets. Do not
change proxy code or increase test timeouts until the bind itself succeeds.

## Release record

| Time (UTC) | Deployment / alias | Competition | Baseline run | Gate | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-07-31 07:55 | `dpl_412RFHUaUN7ZyNSJWziurzKTvKTR` / production | `a9728aea-0ee0-47f6-b23c-851d5e12c160` · Inkling Small · Baseten | `339a5d3a-96ea-4030-92af-b2f880802a7b` | STOP | 16/16 requests hit `/v1/v1/messages`; infrastructure-invalid 0/16. Wafer board closed only after successor creation. |
| 2026-07-31 08:06 | `dpl_7fEAfZV3eGehXHqfU6DYvrCvvJJh` / production | same | `f2f273c6-7b3b-4106-856d-184a6b99e64f` | STOP | Path fixed and Baseten returned 200 plus response ID; Pi was killed by buffered verbose JSON before a tool turn, then verifier ran against untouched workspace. |
| 2026-07-31 08:31 | `dpl_C2LLr1qAnFRAHfhXGJFkuGdd5gMc` / production | no competition mutation | none | STOP | Bounded-output build deployed, but release automation parsed mixed CLI output as `dpl_}` and stopped before admin calls. Secret was discarded and rotated again. |
| 2026-07-31 08:33 | `dpl_5mW6nieY9ymp3jsM64cjACPUn7ML` / production | `eda31800-e401-4c40-a112-b101079dd7f4` · Inkling Small · Baseten | `a6afbfa7-7515-4637-9d73-df9eee0bd569` | GO | 9/16, $2.2982. All 16 tasks correlated; 481/481 requests were exact-model, Baseten-only HTTP 200 responses with nonzero bytes/chunks and no stream errors. `headless-terminal` hit its documented 900s agent timeout after 20 turns/1,464 output tokens, so it is a legitimate model/task timeout. Four diagnostic captures truncated without killing Pi. |
| 2026-07-31 14:29 | `dpl_8tGwqf5S2EmeGDfbDPEv9aVfb7gU` / production | same live competition | custom-prompt canary `878f8224-e54e-40a9-b6d5-c7f5be83f364` | GO | Proxy now caps Inkling at Baseten's 262,144 output ceiling. Canary task 1 produced 11 exact-model Baseten-only HTTP 200 responses, 11 Pi turns/3,482 output tokens, then passed verification. Official first-party Thinking Machines logo also shipped. |

## Entrant release record

| Created (UTC) | Entry | Submission | Run | State |
| --- | --- | --- | --- | --- |
| 2026-07-31 14:06 | Evidence Loop | `9de8b34e-164c-4ee1-97a5-e81218255650` | `7bc65b8e-ff02-4270-a222-16043a8ee486` | INFRA INVALID · custom prompt sent `max_tokens` above Baseten's 262,144 ceiling; 16/16 HTTP 400 before inference |
| 2026-07-31 14:06 | Contract First | `b1a70582-277c-410c-8b8b-34d220c4a91a` | `efd6d6c8-41df-42ea-955a-12aa363a5db9` | INFRA INVALID · same deterministic request-construction failure |
| 2026-07-31 14:07 | Verifier Driven | `fb06836f-8dec-4e62-999e-b2dae1972fb6` | `a760aa4e-643f-4934-94b8-18eccf196793` | INFRA INVALID · same deterministic request-construction failure |
| 2026-07-31 14:31 | Evidence Loop Canary | `4dd8a03d-00b9-4c1b-9a4d-40a7961798e8` | `878f8224-e54e-40a9-b6d5-c7f5be83f364` | RUNNING · custom-prompt canary passed task 1 with productive Baseten/Pi/verifier evidence |
| 2026-07-31 14:33 | Contract First v2 | `19e8bb7b-adc8-426e-9bb0-7c2cc92805b9` | `c88989a2-9cc1-4173-8752-85c3e784f3a5` | RUNNING |
| 2026-07-31 14:34 | Verifier Driven v2 | `3375a74e-6885-4440-be39-84a71da5106b` | `f0526281-6f03-4c87-9219-0889d13fa9ae` | RUNNING |
