# Least-privilege agent access

`config/agent-access-policy.json` is the versioned contract for the monitor and
diagnostic identities. Both roles are observational. Neither role may deploy,
change GitHub, decrypt Vercel environment values with a static identity, hold a
Blob read-write token, create or control Sandboxes, or spend through AI Gateway.

## Access matrix

| System | Required evidence | Explicitly forbidden |
| --- | --- | --- |
| GitHub | Fine-grained PAT or GitHub App with metadata, contents, Actions, issues, and pull requests at `read` | Repository write/admin/owner/maintain/triage permissions |
| Vercel | Team and project `VIEWER`; deployment, logs, and environment-name/scope metadata | Owner, admin, developer/member, deploy, env mutation, or decrypted values from the standing identity |
| App operations | `OPS_READ_TOKEN` against `/api/ops/v1*`, GET only | Callback, admin, competition, trace upload, or any POST/PUT/PATCH/DELETE |
| Blob | Full inventory and object reads brokered through the bounded GET-only operations API using `OPS_READ_TOKEN` | `BLOB_READ_WRITE_TOKEN` in the agent environment |
| Sandbox | Run/sandbox state brokered through the GET-only operations API | Vercel/Sandbox control token in the agent environment |
| AI Gateway | Provider/error/cost evidence from Vercel logs and operations events | `AI_GATEWAY_API_KEY` or any provider-spend credential |
| Secrets | Monitor: metadata only. Diagnostic: metadata plus separately authorized values through a 0600 ephemeral file | Monitor value access; printing, logging, committing, attaching, retaining, or standing access to other values |

Owner-capable evidence is always `overprivileged`; it can never produce a green
audit. Missing and expired identities are reported as `missing`.

## Run the audit

The audit requires an explicitly supplied `GH_TOKEN` for GitHub reads. It does
not use the GitHub CLI credential store or other inherited authentication, so
the token can be compared locally with `OPS_READ_TOKEN` before any command or
network request. `GH_TOKEN` must be a separately scoped read-only identity.
For a GitHub App installation token, `GH_INSTALLATION_TOKEN_EVIDENCE_FILE`
must name the protected `0600` JSON response retained when that exact token was
issued. The collector compares its `token` field to `GH_TOKEN` in memory, keeps
only the authoritative `permissions` and expiry fields, and never emits the
token. Without that issuance evidence, successful App GETs remain unverifiable;
user and fine-grained PAT GETs can never consume App issuance evidence.

Before any external probe, the collector runs the central credential-separation
attestation across every locally available audit/runtime credential. A collision
fails closed without making a request and the report contains no credential
value or hash.

Vercel proof combines all team roles, `teamPermissions`, direct project member
roles, and complete access-group membership/project-role listings. The strongest
effective role wins; a Viewer label cannot mask an Admin/Developer role or a
write/deploy/admin permission such as `CreateProject` or
`FullProductionDeployment`. Missing arrays, inaccessible access-group data, or
pagination that prevents proving the complete grant set is reported as
unverifiable, never observable.

The default command actively probes the authenticated GitHub and Vercel
identities and the application operations API. It uses documented read-only
`gh api`, Vercel CLI/API, and HTTP GET operations, plus one deliberately
rejected `POST /api/ops/v1` only against the isolated Development host:

```bash
HARNESS_ARENA_URL=https://harness-arena-development.vercel.app \
VERCEL_TEAM_ID=team_id VERCEL_PROJECT_ID=project_id \
pnpm ops:access-audit -- --role monitor --json
```

GitHub CLI and Vercel CLI must already be authenticated as the identity being
audited. Tokens are never accepted as CLI arguments. Successful GitHub GETs
prove endpoint reachability, not the independent fine-grained permission map:
without an authoritative map, GitHub is `missing`. The audit checks Vercel team
role plus explicit or inherited project role, deployment/log/environment-
metadata reads, and three authenticated operations GET endpoints. Hosted targets must be an exact
versioned hostname/project pair: the canonical production hostname belongs to
the live project, while the stable Development hostnames belong to the isolated
Development project. Hosted HTTP, nonstandard ports, unknown hosts, project
mismatches, credentials in URLs, paths, queries, fragments, and redirects are
rejected before `OPS_READ_TOKEN` is attached. HTTP is allowed only for exact
loopback hosts in local mode.

The application health response is fetched first without authorization and
must attest `credential_separation.v1: ok`. Only then does the audit attach the
read token to `/api/ops/v1`. The root must validate as `ops.v1`, advertise a
valid record kind and canonical inventory/summary routes, and attest the same
credential separation. The audit derives `inventory?kind=<advertised>&limit=1`
from that response and schema-checks both inventory and summary responses. An
arbitrary HTTP 200 is not evidence. It does not issue POST, PUT, PATCH, or
DELETE probes.

Fixtures or previously captured metadata may be checked only with the explicit
non-authoritative mode:

```bash
pnpm ops:access-audit -- --offline-evidence /protected/path/access-evidence.json --json
```

Offline evidence can expose missing or overprivileged access, but can never
produce exit 0 or final `observable` proof.

`lib/credential-separation.mjs` is the single runtime policy for credentials
that must never equal `OPS_READ_TOKEN`. Startup, Auth.js, agent-token signing,
admin authorization, runner callbacks, operations authorization, and cursor
signing fail closed if any configured policy credential collides. The health
and operations attestations expose only schema/state/counts—never credential
values or hashes. The versioned JSON policy must exactly match this runtime
list or the audit itself refuses to run.

Exit codes are 0 observable, 2 missing, 3 overprivileged, and 64 invalid input.
The command also scans app, library, and operational source for `process.env`
references. A newly referenced variable or unapproved dynamic lookup makes the
audit non-green until the versioned inventory is reviewed. Runtime boundaries
must enumerate the environment keys they hand off; passing the whole
`process.env` object defeats static inventory and can expose unrelated secrets.
The passive monitor route therefore passes only its four credentials and the
two Vercel runtime guard fields. All four credentials are secret inventory
records with `metadata_presence_only` diagnostics: their values are never
printed, written, or retained as audit evidence.

Monitor audits are green from metadata alone and classify any secret-value
access as overprivileged. Secret values, when a later separately authorized diagnostic requires one,
must be passed through `withEphemeralSecretFile`. It creates a 0600 file in a
0700 temporary directory, redacts returned stdout/stderr, and removes the
directory on normal completion, error, SIGINT, and SIGTERM. `.agent-access-secrets/`
is ignored as defense in depth; the default location remains the OS temp area.

## Vercel limitation and external setup

As reviewed on 2026-08-03, Vercel documents team/project `VIEWER` roles and bearer API tokens, but does not
document a static bearer token whose authority can be independently restricted
to one project at Viewer level. A personal token inherits its user/team access.
Therefore do not reuse the current owner token. Invite a dedicated non-human or
service user to the team as Viewer, grant Viewer access only to the live and
Development projects, and authenticate its CLI/session separately. If the plan
cannot constrain that identity this way, Vercel remains `missing`, not green.
Documented Vercel project roles are normalized before evaluation:
`PROJECT_VIEWER` is the only project-scoped role equivalent to Viewer;
`PROJECT_DEVELOPER` and `ADMIN`/`PROJECT_ADMIN` are write-capable and always
overprivileged. A team Viewer role is inherited only when there is no explicit
project role.

The separately authorized ephemeral secret-value broker is also an external
configuration step. Until it exists, agents receive environment metadata only;
they must not borrow the owner identity to retrieve decrypted values.

Provider references: [GitHub fine-grained token permissions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens),
[Vercel access roles](https://vercel.com/docs/rbac/access-roles),
[Vercel environment CLI](https://vercel.com/docs/cli/env), and
[Vercel decrypted environment-value API](https://vercel.com/docs/rest-api/projects/retrieve-the-decrypted-value-of-an-environment-variable-of-a-project-by-id).

## Operational proof still required

1. Run the authoritative audit with the intended GitHub read identity and dedicated Vercel
   Viewer identity for each project.
2. Run it with the current owner identity and retain only the redacted report;
   it must classify `overprivileged`.
3. Retain static coverage of every mutation method exported by the `/api/ops/v1`
   route family and a live `405 Allow: GET` denial using `OPS_READ_TOKEN` against
   the isolated Development deployment only. CLI inspection resolves the stable
   alias to a deployment ID and unique URL; the documented Vercel deployment
   REST response then supplies the authoritative project ID, alias set, and Git
   SHA. That SHA must equal the local source SHA; the audit reports `missing` when
   either identity or denial evidence is unavailable. It never sends a write
   probe to Production. The same tests fail closed if the read token collides
   with an admin or runner callback credential.
4. Record the invitation/role assignment and short-lived secret broker setup in
   the Epic evidence. These are external configuration changes and are not made
   by this code change.

Rollback is code-only: revert the policy/audit commit and remove the package
script. External Viewer identities must be removed separately by an authorized
human; no production credential is created or changed by this implementation.
