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
vercel curl /api/runs -- --silent
```

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

Generate it in a non-traced shell, send it to Vercel over stdin, keep it only in
process memory for the admin calls, and unset it afterward:

```sh
set +x
unset HISTFILE
COMP_ADMIN_NEXT="$(openssl rand -hex 32)"
print -rn -- "$COMP_ADMIN_NEXT" |
  vercel env update COMPETITION_ADMIN_TOKEN production \
    --sensitive --yes --scope dennisons-projects
```

Never print it, put it in an argument, save it to a project file, pull it back
from Vercel, or include it in this document. Environment changes apply only to
new deployments, so deploy before using the replacement.

## 6. Deploy and prove the serving alias

```sh
DEPLOYMENT_URL="$(vercel deploy --prod --yes --scope dennisons-projects | tail -n 1)"
vercel inspect "$DEPLOYMENT_URL" --wait --scope dennisons-projects
vercel inspect https://harness-arena-psi.vercel.app --scope dennisons-projects
vercel logs "$DEPLOYMENT_URL" --since 10m --level error --no-follow
```

The deployment URL and production alias must resolve to the same ready
deployment. The runner bundle URL is commit-keyed; confirm the deployed commit
contains the intended runner bundle rather than relying on the stable asset
pathname.

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
submission, read its `run_id`, then poll that run through Vercel CLI:

```sh
vercel curl /api/runs/<run-id> -- --silent
vercel curl /api/runs/<run-id>/events -- --silent
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

Do not submit entrants while the baseline gate is red.

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

For several unique prompts:

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
| Pending | pending bounded-output runner deployment | same | pending retry | STOP | Do not admit entrants until real Pi turns and valid gateway correlations are proven. |
