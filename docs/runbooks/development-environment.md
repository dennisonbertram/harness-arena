# Development environment runbook

This runbook is only for the independently reserved **development** Vercel
project. It must never be used to configure, deploy, inspect, or mutate the
live project, its aliases, production Blob, production environment values, or
production data.

## PR #174 preview-routing disclosure source

At commit `f15ba57`, Git integration created an automatic non-production preview
in the existing live Vercel project before the separate development project was
configured. It had no alias, no data mutation, and no request traffic. It did
not change the production deployment or live aliases.

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
3. Keep the missing `host`, `store.id`, `callbackOrigin`, and live store ID
   entries missing until the infrastructure owner provisions and independently
   confirms each value. The manifest intentionally contains no secrets.
4. Run the verifier with an in-memory manifest only; it reports missing
   infrastructure and policy violations without printing secret values.

## Development-only integration and deploy

The infrastructure owner may create a distinct development host, Blob store,
and callback origin in the reserved project. Before any development deploy,
record the assigned non-production identifiers in the manifest and prove they
are distinct from every value under `live`. Do not copy tokens, callback
origins, aliases, or Blob values from production.

Deploy only from `dev` into the reserved project after review. A successful
development deployment does not constitute production approval or authorize a
production deployment.

## Rollback and stop rules

Rollback means removing a development alias or redeploying a prior `dev`
revision in the reserved project only. Never roll back by changing the live
project or its data.

Stop immediately if a command, dashboard, callback, alias, token, project ID,
or Blob store could target production. Stop if the verifier reports a missing
live store ID or any violation. Escalate with identifiers only—never paste
tokens or secrets into an issue, PR, log, or this repository.
