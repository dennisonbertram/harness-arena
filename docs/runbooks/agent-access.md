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
| Blob | Full inventory and object reads brokered through the bounded GET-only operations API | `BLOB_READ_WRITE_TOKEN` in the agent environment |
| Sandbox | Run/sandbox state brokered through the GET-only operations API | Vercel/Sandbox control token in the agent environment |
| AI Gateway | Provider/error/cost evidence from Vercel logs and operations events | `AI_GATEWAY_API_KEY` or any provider-spend credential |
| Secrets | `OPS_READ_TOKEN` is the sole standing application credential; other values are metadata-only or use a separately authorized 0600 ephemeral file | Printing, logging, committing, attaching, retaining, or standing access to other values |

Owner-capable evidence is always `overprivileged`; it can never produce a green
audit. Missing and expired identities are reported as `missing`.

## Run the audit

Create a metadata-only evidence document matching
`agent_access_evidence.v1`. Do not put credential values in it. Then run:

```bash
pnpm ops:access-audit -- --evidence /protected/path/access-evidence.json --json
```

Exit codes are 0 observable, 2 missing, 3 overprivileged, and 64 invalid input.
The command also scans app, library, and operational source for `process.env`
references. A newly referenced variable or unapproved dynamic lookup makes the
audit non-green until the versioned inventory is reviewed.

Secret values, when a later separately authorized diagnostic requires one,
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

The separately authorized ephemeral secret-value broker is also an external
configuration step. Until it exists, agents receive environment metadata only;
they must not borrow the owner identity to retrieve decrypted values.

Provider references: [GitHub fine-grained token permissions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens),
[Vercel access roles](https://vercel.com/docs/rbac/access-roles),
[Vercel environment CLI](https://vercel.com/docs/cli/env), and
[Vercel decrypted environment-value API](https://vercel.com/docs/rest-api/projects/retrieve-the-decrypted-value-of-an-environment-variable-of-a-project-by-id).

## Operational proof still required

1. Run the audit with the intended GitHub read identity and dedicated Vercel
   Viewer identity for each project.
2. Run it with the current owner identity and retain only the redacted report;
   it must classify `overprivileged`.
3. Exercise every operations write probe with `OPS_READ_TOKEN`; all must return
   405 with `Allow: GET`.
4. Record the invitation/role assignment and short-lived secret broker setup in
   the Epic evidence. These are external configuration changes and are not made
   by this code change.

Rollback is code-only: revert the policy/audit commit and remove the package
script. External Viewer identities must be removed separately by an authorized
human; no production credential is created or changed by this implementation.
