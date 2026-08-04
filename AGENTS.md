# Start here

Local coding needs no hosted credentials. From a clean worktree, use
`./scripts/init.sh --check` for read-only prerequisites, then
`./scripts/init.sh` (or `./scripts/init.sh --smoke` for the deterministic
real-HTTP flow). Run the smallest relevant `pnpm test` target first, then
`pnpm test`, `pnpm typecheck`, and `pnpm build` as the change warrants.

Harness Arena is a Next.js app: submissions/prompts pass through the
[fairness gate](lib/judge.ts) before dispatch; local uses file storage while
hosted uses Vercel Blob. The [dispatcher](lib/dispatch.ts) invokes the
[Sandbox boundary](lib/sandbox.ts), which creates Vercel Sandboxes; the
[task manifest boundary](lib/tasks-for-runner.ts) builds the derived task
manifest. The [Sandbox runner](scripts/runner/runner.mjs) executes it via the
pinned AI Gateway/provider and posts authenticated callbacks and
traces/results. Persisted events/results drive
[scoring/UI aggregation](lib/aggregate.ts), while logs/traces and
[GET-only ops](lib/ops-read.ts) provide observation.

Source map: `app/` contains routes and UI, `lib/` contains domain/storage and
safety boundaries, `scripts/runner/` is the Sandbox runner, `scripts/ops/` is
the read-only operator tooling, and `docs/runbooks/` is the operational source
of truth. Start with the [local init runbook](docs/runbooks/local-init.md),
[Development environment runbook](docs/runbooks/development-environment.md),
[agent access runbook](docs/runbooks/agent-access.md),
[Development policy](config/development-environment.json), and
[access policy](config/agent-access-policy.json); link rather than copy their
details into code or PRs.

Keep the boundaries explicit: local uses `STORAGE=file` only; hosted
Development is the isolated `dev` branch/project and native Git owns its
deployments; production is read-only and must never be mutated. External
observer credentials are optional and operator-only: local development does
not need them, and an agent must report missing access rather than borrow an
owner credential or print a secret.

Before implementation, create an Epic and a PR-sized native GitHub subissue.
Red first: add the regression test, run it, and confirm it fails for the
expected reason before the fix. Preserve the existing development-only,
lineage, rollback, and review rules below.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Use Vercel CLI for production evidence

For every task involving Vercel production or preview behavior — deployments,
runtime failures, missing or stale data, AI Gateway/provider behavior, slow
requests, or a discrepancy between local and hosted behavior — use the Vercel
CLI early as a mandatory evidence source. Do not rely only on the dashboard,
browser symptoms, repository inference, or application APIs.

At minimum:

1. Identify the deployment actually serving the target hostname with
   `vercel ls` and/or `vercel inspect`.
2. Query runtime logs with `vercel logs`, using the relevant deployment,
   environment, time range, status code, level, request ID, or text filters.
3. After a fix is deployed, repeat the CLI checks against the new production
   deployment and confirm both the expected requests and the absence of the
   original errors.
4. State which facts came from Vercel and which could not. Vercel runtime logs
   only contain platform metadata and output the application emitted; request
   bodies, prompt sizes, proxy translations, and provider responses require
   structured application logging if they are not exposed by a documented
   Vercel API.

Use the authenticated Vercel REST API or SDK when it provides information the
CLI cannot query directly. Never print or commit Vercel tokens. If CLI/API
access is unavailable, report the exact authentication or permission blocker
instead of silently proceeding without production evidence.

# Vercel deployment boundary

Vercel native Git integration owns Development deployments. The isolated
project `harness-arena-development` / `prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA`,
owned by team `team_cwyLpng8LCwWgINdiQ27hHYa`, uses protected `dev` as its
Vercel Production Branch. This Vercel label applies only inside the isolated
Development project and never authorizes the live project or live resources.

`node scripts/ops/vercel-development.mjs verify <exact-reviewed-sha>` is a
read-only, fail-closed verifier. It checks the stable protected remote `dev`
tip and isolated project linkage/settings; it does not archive, upload,
deploy, promote, roll back, or mutate aliases, domains, environments, or
stores. Agents must not run raw write-capable Vercel commands or configure the
Git integration. `RUNNER_NETWORK_MODE=allow-all` is forbidden in every Vercel
environment.

Production evidence remains read-only: `inspect`, `ls`, `logs`, `activity`,
alias identity, and environment metadata inspection are permitted. Do not read
credential values. The live project `prj_f4ppu0xpO0LZeHOAH99RHotVbwyo` is
never a wrapper target.

# Regression tests come first

# Epic-first delivery

All work starts with an Epic and a PR-sized native GitHub subissue before
implementation. The issue must have a native parent labeled `epic`; checklists
and textual parent references are not lineage. Use the Epic and implementation
slice forms, record red/green evidence, and preserve the operator, rollback,
and handoff path. Emergency work uses an incident Epic and native follow-up
subissue rather than a silent bypass.

`main` PRs use GitHub native `closingIssuesReferences`: exactly one closing
issue, with both that issue and its native Epic parent in this repository.
`dev` PRs must contain exactly one standalone same-repository `Closes #N` line.
The referenced issue is queried and must be a native child of a same-repository Epic
labeled `epic`; cross-repository, malformed, or extra closing references fail
closed. Development-only work stays on `dev` and must never be retargeted to or merged into `main` without explicit future approval.

**Before writing any new feature, write the test that would have caught the
last bug in that area — and watch it fail.** A test authored after the fix, and
never seen red, proves nothing: it may assert on behaviour that was already
passing.

Non-negotiable for every change:

1. **Red first.** Run the new test against the unfixed code and confirm it
   fails *for the reason you expect*. A test that passes before the fix is not
   a regression test.
2. **Derive, don't enumerate.** When something must stay in sync with something
   else, compute the expectation instead of hand-listing it. A run failed in
   production with `Cannot find module '.../gateway-proxy.mjs'` because the
   sandbox bundle copied a hand-maintained file list that a new import was not
   on. The fix was not adding the file — it was deriving the required set from
   the runner's actual imports, so the same class of bug cannot recur.
3. **Assert the failure mode, not the happy path.** The interesting cases are
   the judge being down, the blob read that half-succeeds, the provider option
   the gateway accepts and silently ignores. Those are what break in
   production; the happy path is what you already checked by hand.
4. **Verify the test can fail.** For a fix, revert it and re-run. For a guard,
   break the thing it guards. If you cannot make it go red, you have not
   written a test — say so rather than claiming coverage.

Coverage thresholds are enforced (90% statements) but they measure lines
executed, not behaviour pinned. Clearing the gate is not evidence the change is
safe.
