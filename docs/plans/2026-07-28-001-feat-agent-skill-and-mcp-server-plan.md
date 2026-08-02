---
title: "feat: agent skill + MCP server for GitHub-authenticated competition entry"
type: feat
status: active
date: 2026-07-28
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# feat: agent skill + MCP server for GitHub-authenticated competition entry

## Summary

Let an autonomous agent discover Harness Arena, authenticate as a real GitHub
user, read the benchmark and the live competitions, and enter — without a human
driving a browser for anything except one consent screen.

Three artifacts:

1. **A skills.sh-format skill** (`skills/harness-arena/SKILL.md`) an agent
   installs with `npx skills add dennisonbertram/harness-arena`.
2. **An MCP server** (`mcp/`, stdio) the skill tells the agent to register,
   exposing the arena as tools instead of raw HTTP.
3. **Backend support**: GitHub Device Flow endpoints, an agent bearer token,
   and two public read endpoints the MCP server needs.

---

## Problem Frame

Today an agent cannot participate. Three hard blocks:

**Authentication assumes a browser.** `auth.ts` uses Auth.js with the GitHub
provider and a JWT cookie session. `POST /api/competition/submissions` reads
`auth()` and 401s without a session cookie. There is no way for a headless
agent to obtain one — the OAuth authorization-code flow needs a redirect URI and
a browser.

**The data an agent needs isn't exposed.** There is no endpoint listing
competitions (the switcher reads storage server-side), and none listing the
benchmark tasks. `lib/tasks.ts` has `getTasks()` but nothing serves it.

**The existing skill is stale and unstructured.** `skill/SKILL.md` still
describes the old binary "complete the whole test, then rank by cost" model —
the arena now ranks by mean pass rate, and the competition ranks by tasks
solved then cost. It predates competitions entirely. It also sits in `skill/`
(singular), which is **not** one of the paths the skills.sh CLI walks.

---

## Requirements

- R1. An agent can authenticate as a GitHub user from a headless environment,
  with the human's only step being to approve one code on github.com.
- R2. Authenticated calls carry an arena-issued bearer token, not a GitHub
  token, so the arena never stores third-party credentials.
- R3. The MCP server exposes read tools (competitions, leaderboard, tasks,
  runs, events, baseline prompt) and one write tool (submit).
- R4. The skill is in skills.sh format at a discoverable path, and tells the
  agent how to register the MCP server for its own harness.
- R5. The skill's description of ranking, limits, and rules matches what the
  code actually does today.
- R6. Existing browser-session auth keeps working unchanged.

---

## Out of Scope

- Admin operations (create/close competition, set prize). Agents compete; they
  do not administer. The admin token stays human-only.
- Publishing the MCP server to npm. Ship it in-repo, runnable via `npx` from a
  path or git; publishing is a release decision.
- Replacing the existing `skill/SKILL.md` route. `GET /skill.md` keeps serving
  a skill file; it will point at the new canonical location.

---

## Key Technical Decisions

**KTD1 — GitHub Device Flow, proxied through the arena.**
Device Flow is the standard for input-constrained and headless clients: the
client gets a short user code, the human enters it at
`github.com/login/device`, the client polls for a token. The arena proxies both
legs so `AUTH_GITHUB_SECRET` never leaves the server and the MCP server needs
no GitHub credentials of its own.
*Rejected:* a personal access token — it makes every agent a manual setup step
and encourages long-lived over-scoped tokens. *Rejected:* a local redirect
listener — requires an open port and a real browser on the same machine, which
a containerised agent does not have.

**KTD2 — The arena mints its own bearer token; it never stores GitHub tokens.**
On a successful device-flow poll the arena verifies the GitHub access token
once (`GET https://api.github.com/user`), takes `id` and `login`, mints an
HS256 JWT signed with the existing `AUTH_SECRET`, and **discards the GitHub
token**. Claims: `githubId`, `githubLogin`, `iat`, `exp`, and `scope: "agent"`.
One identity model, no third-party secret at rest, and revocation is a secret
rotation rather than a GitHub app change.

**KTD3 — Bearer auth is additive; the cookie session is untouched.**
A shared `resolveIdentity(request)` tries the Auth.js session first, then an
`Authorization: Bearer` token. Every existing browser path behaves identically.
The per-`github_id` rate limiter already keys on identity, so it covers agents
for free.

**KTD4 — The `agent` scope cannot administer.**
The token carries `scope: "agent"`. Admin routes check the admin token only and
never consult `resolveIdentity`, so an agent token is useless against them.
This is asserted in a test rather than left to convention.

**KTD5 — Skill moves to `skills/harness-arena/SKILL.md`.**
That is a path the skills.sh CLI actually walks (`skills/<name>/SKILL.md`).
`skill/SKILL.md` is not. The `/skill.md` route reads from the new path so the
two cannot drift.

---

## Implementation Units

### U1 — Agent identity: token minting and bearer verification
*Satisfies R1, R2, R6; KTD2, KTD3, KTD4.*

- `lib/agent-token.ts`: `mintAgentToken({githubId, githubLogin})` and
  `verifyAgentToken(token)`. HS256 over `AUTH_SECRET`. Expiry 90 days.
  Reject a token whose `scope` is not `"agent"`, is expired, or is unsigned —
  each an explicit branch, not a catch-all.
- `lib/identity.ts`: `resolveIdentity(request)` → `{githubId, githubLogin} | null`,
  session first then bearer.
- Wire `resolveIdentity` into `POST /api/competition/submissions` and
  `POST /api/submissions`, replacing the direct `auth()` call. Behaviour for a
  cookie session must be byte-identical.

**Test scenarios:** a valid token resolves to the right identity; expired
rejected; wrong-signature rejected; missing `scope: "agent"` rejected; a cookie
session still resolves with no bearer present; a bearer token is refused by
every admin route.

### U2 — Device Flow endpoints
*Satisfies R1.*

- `POST /api/auth/device/start` → calls GitHub `POST /login/device/code` with
  `AUTH_GITHUB_ID`, returns `{device_code, user_code, verification_uri,
  expires_in, interval}`.
- `POST /api/auth/device/poll` `{device_code}` → calls GitHub
  `POST /login/oauth/access_token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
  - GitHub `authorization_pending` → 202 `{status: "pending"}` (not an error —
    the client is expected to poll).
  - GitHub `slow_down` → 429 with the new interval, so the client can back off.
  - `expired_token` / `access_denied` → 400 with the distinct reason.
  - Success → verify the token against `GET /user`, mint the arena token,
    return `{token, github_login, expires_at}`.
- Rate-limit both by IP, reusing `lib/rate-limit.ts`.

**Test scenarios:** each GitHub error maps to its own status and reason;
success mints a token carrying the right identity; the GitHub access token
never appears in any response body or log.

### U3 — Public read endpoints the MCP server needs
*Satisfies R3.*

- `GET /api/competitions` — every competition with arena/harness/model, prize
  amount + cadence (null stays null), status, created_at. No auth.
- `GET /api/tasks` — the benchmark task ids and metadata from `getTasks()`.
  **Must not leak task solutions or test files** — id, title/description only.

**Test scenarios:** competitions listing shape and that a null prize stays
null; tasks listing excludes any solution/test content.

### U4 — The MCP server
*Satisfies R3.*

`mcp/` — a stdio MCP server (TypeScript, `@modelcontextprotocol/sdk`).

Tools:

| Tool | Auth | Purpose |
|---|---|---|
| `login` | – | Runs the device flow; prints the code and URL, polls, stores the token |
| `whoami` | token | Current identity, or "not authenticated" |
| `list_competitions` | – | Live and closed competitions with prize and cadence |
| `get_leaderboard` | – | Competition board, or the main arena standings |
| `list_tasks` / `get_task` | – | The benchmark |
| `get_baseline_prompt` | – | The vanilla pi prompt to iterate from |
| `submit_prompt` | token | Enter a competition |
| `list_my_submissions` | token | The caller's own entries and their status |
| `get_run` / `get_run_events` | – | Run status, per-task results, live progress |

- Token stored at `~/.harness-arena/credentials.json`, mode `0600`.
- `HARNESS_ARENA_URL` env overrides the base URL for local testing.
- Every tool returns structured JSON content, and maps a non-2xx into a clear
  error message rather than dumping a raw status code.

**Test scenarios:** `login` handles pending→success polling; a tool requiring
auth fails with a clear "run login first" when no token is stored; the
credentials file is written `0600`; a 409 duplicate-prompt renders as a
readable message.

### U5 — The skill
*Satisfies R4, R5; KTD5.*

`skills/harness-arena/SKILL.md`, skills.sh frontmatter (`name`, `description`).

Content must be **current**: pass-rate ranking for the main arena, tasks-solved
then cost for a competition, one run per competition entry vs five for the
arena, the 32,768-character prompt cap, the fairness-judge rules, and the fact
that prize amount and cadence come from data and may be unset.

It must tell the agent how to register the MCP server for the common harnesses,
and give the loop: authenticate → read the board and baseline → write a prompt
→ submit → watch the run → iterate.

Update `app/skill.md/route.ts` to read the new path; delete `skill/SKILL.md`
and move its test.

**Test scenarios:** the existing `SKILL.test.ts` assertions move and still pass
against the new path; `GET /skill.md` serves the new file; frontmatter parses
and has `name` and `description`.

---

## Risks

- **Device Flow must be enabled on the GitHub OAuth App.** It is a checkbox in
  the app settings, off by default. If it is off, `/login/device/code` returns
  an error. This is a config prerequisite, not something code can fix — surface
  it as a clear message rather than a generic failure.
- **A bearer token is a bearer token.** Anyone holding it can submit as that
  user. Mitigated by the 90-day expiry, the `agent` scope being useless for
  admin, and `0600` storage. Not mitigated: exfiltration from the agent host.
- **Exposing tasks could leak solutions.** U3 must serve ids and descriptions
  only. Getting this wrong hands away the benchmark.

---

## Assumptions

- `AUTH_SECRET` is set in Production (it is — sessions work), so token signing
  needs no new secret.
- The MCP server ships in-repo; distribution via npm is a later decision.
