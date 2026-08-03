# Development environment runbook

This runbook is only for the independently reserved **development** Vercel
project. Read-only inspection of live identifiers, routing, and deployment metadata is required to establish and refresh the isolation boundary.
The boundary forbids all live mutations, deploys, promotions, rollbacks, alias changes, environment changes, store changes, data changes, credential value reads, and mutating application access.

## PR #174 preview-routing disclosure source

At commit `f15ba57`, Git integration created automatic non-production preview
`dpl_6MxLwsV4wFWDysCEoNGWYyqCyYrg` in the existing live Vercel project before
the separate development project was configured. It reached READY and did
receive branch alias
`harness-arena-git-codex-dev-environme-19f8e1-dennisons-projects.vercel.app`.
It had no data mutation and no request traffic.

A separate production incident must not be conflated with that preview:
`dpl_26QP6baT4WeaZxz68nehTFGSCJwz` was a Codex CLI `target=production`
dirty-worktree deployment that moved the `harness-arena-psi.vercel.app` and
`harness-arena-dennisons-projects.vercel.app` generic aliases. The Git-main
alias remained on `dpl_2ToduY94C37uH3PxELU11q59LGDd` at source SHA `330b484`.
The dirty deployment is not a valid unchanged production baseline. This work
does not authorize or perform any production correction.

Before any further push or deploy, the infrastructure owner must verify
live-project branch-ignore routing that allows only production-bound Git work
to build there. A skipped or canceled live-project check—not a preview
deployment—is the required evidence after each development-branch push. This
text is the source disclosure for the draft PR body until the routing gate and
review are complete.

## Before any integration

1. Work from the `dev` branch and a PR whose body contains exactly one line of
   the form `Closes #N`. The referenced issue must be local to this repository
   and have native parent Epic `#139`.
2. Inspect `config/development-environment.json`. It identifies the reserved
   project `harness-arena-development` / `prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA`.
3. Keep the missing development `host`, `store.id`, and `callbackOrigin`
   entries missing until the infrastructure owner provisions and independently
   confirms each value. The known live Blob store identifier is recorded only
   as an identifier; the manifest contains no token or other secret.
4. Before any Development configuration or deploy, refresh the complete live alias and Blob store identifier inventory
   with read-only Vercel inventory access. Compare it with the manifest and stop
   on any omitted or changed identifier. Never retrieve or print Blob
   credentials during this preflight.
5. Run the verifier; it reports missing infrastructure and policy violations
   without printing secret values.

## Development-only integration and deploy

The infrastructure owner may create a distinct development host, Blob store,
and callback origin in the reserved project. Before any development deploy,
record the assigned non-production identifiers in the manifest and prove they
are distinct from every value under `live`. Do not copy tokens, callback
origins, aliases, or Blob values from production.

Deploy only from `dev` into the reserved project after review. A successful
development deployment does not constitute production approval or authorize a
production deployment.

The sole approved mutation entry point is:

```sh
VERCEL_TOKEN='<development-token>' node scripts/ops/vercel-development.mjs deploy <exact-reviewed-origin-dev-sha>
```

It queries the protected `origin/dev` ref read-only and requires the explicit
reviewed SHA to equal that exact remote tip with valid local ancestry. Branch
names and worktree cleanliness are not provenance. The wrapper uploads only a
validated temporary `git archive` of that SHA, never the mutable or ignored
working tree, and always removes the temporary snapshot.

Before upload it reads the actual project, Preview callback, and Blob-store
metadata and compares their non-secret identities with the manifest. It then
uses the pinned local Vercel CLI version `56.5.0` through the absolute Node
executable, with a minimal environment fixed to project
`prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA`, team
`team_cwyLpng8LCwWgINdiQ27hHYa`, scope `dennisons-projects`, and the supplied
token. Preview is Vercel's built-in non-production deploy mode. The option
`--target development` is forbidden. A read-only postflight must prove the
deployment's project, owner, Preview target, URL, and reviewed SHA before
success is reported.

The repository manifest must fully verify before any mutation. The CLI accepts
no extra options.
Raw write-capable Vercel CLI commands are forbidden in this runbook. This
includes deploys with production targets, promote/rollback, alias/domain,
environment, and store mutation. Read-only production `inspect`, `ls`, `logs`,
`activity`, alias-identity, and environment-metadata checks remain permitted.

## Rollback and stop rules

Rollback is not an approved wrapper operation. Stop and obtain a separately
reviewed development-only policy rather than changing a live project, alias,
or data.

Stop immediately if an operation goes beyond read-only inspection of live
identifiers, routing, or deployment metadata, or if it could read credential
values or mutate the live project or application. Stop if the verifier reports
a missing live store ID or any violation. Escalate with identifiers only—never
paste tokens or secrets into an issue, PR, log, or this repository.
