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
3. Confirm that Vercel native Git integration links only
   `dennisonbertram/harness-arena` to that isolated project. The Vercel
   Production Branch for this project is `dev`. “Production” here is Vercel's
   routing label inside the Development project; it is not the live project,
   live environment, or production approval.
4. The provisioned Development data plane is
   `harness-arena-development.vercel.app`, Blob store
   `store_9AIBHzkDp5mZ1SnM`, and callback origin
   `https://harness-arena-development.vercel.app`. The known live Blob store
   identifier is recorded only as an identifier; the manifest contains no token
   or other secret.
   `CALLBACK_BASE` is required for Sandbox runs and must equal the manifest's
   `callbackOrigin`: a canonical, publicly reachable HTTPS origin for the
   isolated Development deployment that Vercel Sandbox can reach. It must have
   no credentials, port, path, query, or fragment. A localhost, loopback,
   production, or live origin is invalid.
   A hosted seeded Development identity additionally requires the explicit
   `HARNESS_DEVELOPMENT_IDENTITY=seeded` marker, exact manifest project,
   protected `dev` ref, canonical request host/callback, and
   `HARNESS_BLOB_STORE_ID` matching the isolated manifest store. Missing or
   unknown identities fail closed. Every live project, alias, callback, and
   store identifier is denied. The complete manifest enables a hosted seeded
   identity only when every runtime identity check succeeds.
5. Before any Development configuration or deploy, refresh the complete live alias and Blob store identifier inventory
   with read-only Vercel inventory access. Compare it with the manifest and stop
   on any omitted or changed identifier. Never retrieve or print Blob
   credentials during this preflight.
6. Run the verifier with a read-only-scoped token. It reports missing
   infrastructure and policy violations without printing secret values:

   ```sh
   VERCEL_TOKEN='<read-only-token>' node scripts/ops/vercel-development.mjs verify <exact-reviewed-origin-dev-sha>
   ```

## Native Git deployment ownership

The infrastructure owner may create a distinct development host, Blob store,
and callback origin in the reserved project. Record those identifiers in the
manifest and prove they are distinct from every value under `live`. Do not copy
tokens, callback origins, aliases, environment values, or Blob resources from
the live project.

After a reviewed change reaches protected `dev`, Vercel native Git integration
is the only deployment owner for the Development project. The repository has
no deploy wrapper and no postflight mutation path. The verifier resolves the
fixed GitHub URL outside the repository with user/system/repository Git config
and replacement objects disabled, checks the remote `dev` SHA before and after
Vercel inspection, and requires both observations to equal the explicit
reviewed SHA.

Vercel inspection is GET-only, bounded by request deadlines and response-size
limits, and fixed to the Development project and team. It checks GitHub repo
linkage, the `dev` Production Branch, Development alias/callback/store
identities, and separation from the complete live inventory. It never decrypts
credential values; the only decrypted value is the non-secret `CALLBACK_BASE`
needed to prove isolation. `RUNNER_NETWORK_MODE` must not be configured in the
Vercel project, and runtime code rejects `RUNNER_NETWORK_MODE=allow-all` in
Production, Preview, and Development Vercel contexts.

Issue #175 verifies this read-only metadata boundary; it does not remove write
authority from an owner-capable Vercel credential. Issue #148 must enforce a
least-privilege verifier identity with credential-level no-write authority.
That credential restriction is the technical control: a repository wrapper
cannot prevent an operator from invoking the raw owner-authorized Vercel CLI.

Do not run write-capable Vercel commands from this repository. Do not manually
upload, promote, roll back, or change aliases, domains, environments, stores,
or Git linkage. A successful Development deployment is not production
approval and never authorizes mutation of the live project.

The optional `./scripts/init.sh --real-sandbox-smoke` is not a deployment or
application smoke. It uses local scoped credentials only to create a bounded,
deny-all, non-persistent, non-production Sandbox, run one harmless command, and permanently delete it in a
`finally` path. It never uses `CALLBACK_BASE`, reaches the Development or live
data plane, invokes a model, or asserts that a remote Sandbox can callback to
localhost. Do not run it with the live project ID.

## Rollback and stop rules

Rollback is not an approved repository operation. Stop and obtain a separately
reviewed development-only policy rather than changing any project, alias, or
data.

Stop immediately if an operation goes beyond read-only inspection of live
identifiers, routing, or deployment metadata, or if it could read credential
values or mutate the live project or application. Stop if the verifier reports
a missing live store ID or any violation. Escalate with identifiers only—never
paste tokens or secrets into an issue, PR, log, or this repository.
