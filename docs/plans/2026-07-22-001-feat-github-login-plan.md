---
title: "feat: GitHub login as submission identity"
type: feat
status: active
date: 2026-07-22
deepened: 2026-07-25
---

# feat: GitHub login as submission identity

## Summary

Require GitHub sign-in to submit an agent, on **both** submission surfaces — the main arena (`/submit` → `POST /api/submissions`) and the daily prompt competition (`/competition` → `POST /api/competition/submissions`, added 2026-07-25, after this plan was first written): Auth.js (next-auth v5 beta) with the GitHub provider and JWT sessions (no database), the submitter's GitHub id/login stamped server-side on every stored submission, both surfaces' rate limits rekeyed from IP+free-text-name to IP+GitHub account, and sign-in UI in the shared header and both submit forms. Existing anonymous submissions AND competition entries (including the competition baseline) — and their runs/events/traces — are wiped, since they share the same storage prefixes; the competition baseline must be re-triggered via its admin endpoint after the wipe.

## Problem Frame

Submissions are anonymous today on both surfaces — `agent_name` is free text the client supplies, so nothing ties a leaderboard entry to a real person and the only abuse boundary is a per-IP (main arena) or per-IP-plus-agent-name (competition) rate limit. GitHub login gives each submission a stable, costly-to-mint identity without introducing a database: the app has no SQL store (Vercel Blob JSON documents only), which rules out adapter-backed auth libraries and makes cookie-held JWT sessions the fit. The competition specifically motivated this: its leaderboard should identify entrants by GitHub username, not the free-text `agent_name` it currently collects but deliberately hides (see the competition plan's R7/KTD6, `docs/plans/2026-07-25-001-feat-daily-prompt-competition-plan.md`), and a GitHub account is the natural way to let one person submit multiple competition entries under one stable identity.

---

## Requirements

**Identity and gating**

- R1. Both `POST /api/submissions` (main arena) and `POST /api/competition/submissions` (competition) require a signed-in GitHub session; unauthenticated requests get 401 from either.
- R2. Stored submissions carry `github_id` (number, required) and `github_login` (string, required) on **every** new submission — main arena and competition alike — taken from the server-side session only, never from the request body.
- R3. Rate limiting is rekeyed to the account on both surfaces:
  - Main arena: the existing 5/hour limiter is enforced per `github_id` **and** per IP (unchanged from the original scope of this plan) — both buckets must admit the request.
  - Competition: its two existing buckets (per-IP, per-`agent_name`) become per-IP and per-`github_id` — the `agent_name` bucket is replaced, not kept alongside, since `agent_name` is no longer the identity axis and an attacker could otherwise mint new names to bypass a name-keyed limit while easily reusing one GitHub account.
  - A GitHub account alone is cheap to mint, so dropping the IP key on either surface would weaken today's abuse boundary while every admitted submission triggers a real budget-capped sandbox run.
- R11. The admin baseline-trigger endpoint (`POST /api/competition/admin/baseline`) is **not** gated by GitHub session — it keeps its existing `COMPETITION_ADMIN_TOKEN` header gate, a different authority (the admin, not a submitting user). Out of scope for this plan to change.

**Sign-in UX**

- R4. The shared header shows "Sign in with GitHub" when signed out, and the user's login plus sign-out when signed in, on every page.
- R5. Both submit surfaces show an explanation plus sign-in button when signed out (returning to the originating page — `/submit` or `/competition` — after OAuth), and the submission form with the signed-in identity when signed in.
- R6. Both submit forms distinguish error responses: 401 shows a session-expired message with a re-auth path that does not discard the typed prompt; 429 shows rate-limit copy naming the retry window; judge rejection and (for the competition form) duplicate-prompt rejection keep their current distinct messages.
- R7. Cancelling or failing the GitHub OAuth consent lands the user on a page with a retry path, not the unstyled Auth.js default error page.

**Display**

- R8. Main arena's leaderboard, status page, and run detail show the submitter's `github_login` alongside the agent name; pages must not break on missing/wiped data. `github_id`/`github_login` are already-public GitHub data — exposing them on stored submissions (including the public submissions listing) is intended.
- R12. The competition leaderboard (`app/competition/page.tsx`, `lib/competition-leaderboard.ts`) shows the entrant's `github_login` in place of the currently-shown truncated submission id — this is the change that originally motivated this plan for the competition ("the leaderboard ranking is not by agent name but rather it's by GitHub username"). The competition's baseline row is unaffected (it has no submitting user — it's admin-triggered — and keeps its "Baseline" label).

**Data reset and ops**

- R9. A wipe script deletes all existing `submissions/`, `runs/`, `events/`, and trace blobs; it is dry-run by default and requires an explicit flag to delete. Because competition submissions (including the `competition_baseline: true` entry) live in the same `submissions/`/`runs/` prefixes, this wipe removes them too — no separate competition-scoped wipe exists or is needed, but the operational rollout (below) gains a step to re-trigger the competition baseline afterward.
- R10. Setup is documented: `.env.example` gains the auth vars; two GitHub OAuth apps (localhost dev, production); Vercel preview deploys documented as not supporting login.

---

## Key Technical Decisions

- **`next-auth@5.0.0-beta.32`, pinned.** Peer deps admit `next@16` only from `5.0.0-beta.30` (earlier betas fail install — nextauthjs/next-auth#13302). Runtime behavior on this Next fork is unverified beyond peer deps, so U1 ends with a manual sign-in smoke before anything builds on it.
- **JWT sessions, no adapter, no users store.** There is no database; identity lives in the encrypted session cookie. Default 30-day session accepted for this low-stakes leaderboard/competition. A users entity is deferred until bans/quotas need one.
- **Auth.js over Better Auth and hand-rolled OAuth.** Better Auth assumes an adapter-backed persistence model this app doesn't have, and its compatibility with this Next fork is equally unverified — adopting it would trade a confirmed peer-dep story for an unconfirmed one. Hand-rolled OAuth re-implements a trust boundary a maintained library covers; it survives only as U1's runtime-failure fallback.
- **`github_id` is the identity key; `github_login` is display-only.** Logins can be renamed; the numeric id is stable. Login renders as inert text (no `github.com/<login>` link that could 404 after a rename), stamped at submission time and never refreshed.
- **Claims are copied from the raw OAuth `profile` in the `jwt` callback** (`profile.id`, `profile.login`) — the provider's default user mapping does not expose `login`. TypeScript module augmentation types the custom session fields.
- **Sessions without `githubId` claims are treated as unauthenticated.** Guards against stale cookies from before this feature or across claim-shape changes.
- **Server-action sign-in/out; no `SessionProvider`/`useSession`.** Both submit pages (`app/submit/page.tsx`, `app/competition/page.tsx`) are already server components; `auth()` covers all reads. Each becomes a thin server shell that gates on session and renders its existing client form (extracted, for `/submit`; already extracted as `SubmitCompetitionForm.tsx` for `/competition`) as a child. Keeps the client bundle unchanged.
- **One shared session-gate pattern, two call sites.** Both routes call the same `auth()` helper and apply the same 401/claims-missing logic — no route-specific auth variant. `(session-settled: user-directed — chosen over gating only the main arena: user explicitly said "every user logs in first before being able to submit a prompt" and confirmed both surfaces when asked, rejecting the narrower main-arena-only scope this plan originally had.)`
- **Wipe, not backfill — now spanning both surfaces.** Old anonymous submissions (main arena AND competition, including the competition baseline) are deleted (owner decision, reconfirmed for the competition's data specifically when asked), including their runs, events, and traces — leaderboard/status/competition views join runs to submissions and would otherwise show orphaned "unknown" rows. `(session-settled: user-directed — chosen over wiping main-arena data only: user explicitly confirmed "wipe everything, including competition data" when asked, since gating both surfaces makes pre-login competition entries just as identity-less as pre-login main-arena ones.)`
- **Competition's rate-limit rekey replaces the `agent_name` bucket, not just the main arena's IP bucket.** The competition's existing per-`agent_name` bucket (`lib/rate-limit.ts`) was already a weaker stand-in for real identity; now that `github_id` exists, it fully replaces that bucket rather than adding a third one, since `agent_name` will no longer be an author-controlled identity signal worth rate-limiting on.
- **Default GitHub scopes kept** (`read:user user:email`) — no scope override; id and login are covered. Email is granted by the default scope but is never read from the profile, stored, or logged; overriding the scope string risks provider-behavior surprises for zero data benefit.
- **Runner callback auth untouched.** `x-runner-secret` is machine identity, separate from user identity.
- **Admin baseline endpoint untouched.** Its `COMPETITION_ADMIN_TOKEN` gate is a separate authority from user sign-in and is out of scope for this plan (R11).

---

## High-Level Technical Design

```mermaid
sequenceDiagram
  participant B as Browser
  participant A as app (Next.js)
  participant GH as GitHub OAuth
  B->>A: GET /submit or /competition (signed out)
  A-->>B: sign-in prompt (server-rendered)
  B->>A: POST server action signIn("github", redirectTo <originating page>)
  A-->>B: redirect to GitHub consent
  B->>GH: authorize
  GH-->>B: redirect /api/auth/callback/github
  B->>A: callback (Auth.js handler)
  A-->>B: set JWT cookie (githubId, githubLogin claims), redirect to originating page
  B->>A: POST /api/submissions OR /api/competition/submissions {agent_name, prompt}
  A->>A: auth() → session; 401 if none/claims missing
  A->>A: rate limit by githubId + IP (both must admit); judge; store Submission + github_id/login
  A-->>B: 200/201 (or 401 / 429 / judge rejection / duplicate — distinct client messages)
```

---

## Output Structure (new files only)

```text
auth.ts                              # Auth.js config: handlers, auth, signIn, signOut
app/api/auth/[...nextauth]/route.ts  # re-exports handlers
types/next-auth.d.ts                 # module augmentation: githubId/githubLogin on session
auth.test.ts
app/submit/submit-form.tsx           # extracted client form (main arena)
app/submit/page.test.tsx
scripts/wipe-blob-data.mjs
scripts/wipe-blob-data.test.mjs
```

---

## Implementation Units

### U1. Auth.js wiring and sign-in smoke

- **Goal:** Working GitHub OAuth sign-in/out with `githubId`/`githubLogin` claims available via `auth()`.
- **Requirements:** R2 (claims), R10 (env).
- **Dependencies:** none.
- **Files:** `auth.ts` (new), `app/api/auth/[...nextauth]/route.ts` (new), `types/next-auth.d.ts` (new, module augmentation), `.env.example`, `package.json`, `auth.test.ts` (new).
- **Approach:** Install `next-auth@5.0.0-beta.32` (pin exact). `auth.ts` exports `{ handlers, auth, signIn, signOut }` with the bare `GitHub` provider (env-inferred `AUTH_GITHUB_ID`/`AUTH_GITHUB_SECRET`), `session: { strategy: "jwt" }`, and `jwt`/`session` callbacks copying `profile.id` → `token.githubId`, `profile.login` → `token.githubLogin` and onto `session.user`. Route file re-exports `handlers`. Add `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` to `.env.example`. No proxy/middleware file — nothing is page-gated; both submit routes gate themselves (U2, U2b).
- **Execution note:** Callback tests first (red/green); the OAuth round-trip itself is verified manually.
- **Test scenarios:**
  - `jwt` callback with a GitHub `profile` present copies numeric `id` and `login` into the token; without `profile` (subsequent calls) it leaves existing claims intact.
  - `session` callback exposes `githubId`/`githubLogin` from the token on `session.user`.
- **Verification:** `pnpm typecheck` and `pnpm test` pass; `pnpm dev` then a real browser sign-in against the dev OAuth app round-trips and a signed-in server component can read both claims. This smoke is the go/no-go on the beta's compatibility with `next@16.2.11` — if it fails at runtime, stop and fall back to the fork-documented hand-rolled OAuth + `jose` session (see Risks).

### U2. Gate, stamp, and rekey the main arena submissions API

- **Goal:** Main-arena submissions require a session, carry the submitter's identity, and rate-limit per account.
- **Requirements:** R1, R2, R3.
- **Dependencies:** U1.
- **Files:** `lib/types.ts`, `app/api/submissions/route.ts`, `app/api/submissions/route.test.ts`.
- **Approach:** Add required `github_id: z.number()` and `github_login: z.string()` to the stored `Submission` schema (`SubmissionInputSchema` unchanged — clients still send only `agent_name` + `prompt`). In `POST`: `await auth()`; return 401 when there is no session or the `githubId` claim is missing; build the stored submission with identity from the session; extend the existing in-memory rate limiter to check two buckets — per `github_id` and per IP (`x-forwarded-for`, as today) — rejecting when either is exhausted. 429 body includes the window length so the client can render retry copy.
- **Execution note:** Test-first per scenario below; follow the existing `vi.mock` pattern in this test file.
- **Patterns to follow:** `app/api/submissions/route.test.ts` — `NextRequest` built directly, `vi.mock("@/lib/storage")` with the shared `storageRef`, mocked judge/run-trigger. Mock the app-local auth module the same way (`vi.mock` of the `auth.ts` export; community-documented seam, use a relative path if the alias misbehaves).
- **Test scenarios:**
  - No session → 401; nothing stored, judge not called.
  - Session missing `githubId` claim (stale cookie) → 401.
  - Valid session → 201; stored submission has the session's `github_id`/`github_login`; a `github_login` field sent in the request body is ignored.
  - Rate limit: 6th submission within the hour for one `github_id` → 429 even from different IPs; 6th submission from one IP across different `github_id`s → 429 (account-minting bypass closed); distinct account + distinct IP is admitted; window expiry re-admits both buckets (fake timers, existing pattern).
  - Existing judge-rejection and validation tests still pass unchanged.
- **Verification:** Route test file green; `pnpm typecheck` passes.

### U2b. Gate, stamp, and rekey the competition submissions API

- **Goal:** Competition submissions require a session, carry the submitter's identity, and rate-limit per account — mirroring U2 for the newer competition surface (which didn't exist when this plan was first written).
- **Requirements:** R1, R2, R3 (competition half), R11 (confirms the admin endpoint is untouched).
- **Dependencies:** U1.
- **Files:** `lib/types.ts` (shared with U2 — same `Submission` schema addition covers both surfaces), `app/api/competition/submissions/route.ts`, `app/api/competition/submissions/route.test.ts`.
- **Approach:** `Submission`'s new `github_id`/`github_login` fields (added once in U2) apply here too — no schema duplication. In `POST`: `await auth()` the same way as U2; 401 on no session/missing claim. Replace the `isAgentNameRateLimited` bucket with a `github_id`-keyed bucket (same `createRateLimiter` factory from `lib/rate-limit.ts`, just rekeyed) — drop the agent-name bucket rather than keeping it alongside, per KTD. Stamp `github_id`/`github_login` on the created `Submission` the same way U2 does. Dedup logic (exact-prompt match) is unaffected — it operates on `prompt` text, not identity. `GET /api/competition/admin/baseline` is unaffected (R11) — do not add a session check there.
- **Execution note:** Test-first per scenario below; follow this file's existing `vi.mock` pattern (already established in `app/api/competition/submissions/route.test.ts`).
- **Patterns to follow:** U2's approach and this file's own existing test structure (`postRequest` helper, `vi.mock("@/lib/judge")`, etc.).
- **Test scenarios:**
  - No session → 401; nothing stored, judge not called, dedup check not run.
  - Session missing `githubId` claim → 401.
  - Valid session → 200 with `status: "queued"`; stored submission has `github_id`/`github_login`.
  - Rate limit: 6th submission within the hour for one `github_id` (from varying IPs) → 429; distinct account + distinct IP admitted; IP-bucket exhaustion still independently blocks (unchanged from existing behavior) even with a fresh `github_id`.
  - Existing dedup, judge-rejection, and 413/415/400 validation tests still pass unchanged.
  - `POST /api/competition/admin/baseline` continues to require only the admin token, no session — unaffected by this unit.
- **Verification:** Route test file green; `pnpm typecheck` passes.

### U3. Sign-in UI: header and both submit pages

- **Goal:** Users can sign in/out anywhere, and both submit surfaces gate on session with honest error states.
- **Requirements:** R4, R5, R6, R7.
- **Dependencies:** U1, U2, U2b (401/429 contract on both routes).
- **Files:** `app/layout.tsx`, `app/submit/page.tsx` (becomes server component), `app/submit/submit-form.tsx` (new client component, extracted current form), `app/submit/page.test.tsx` (new or extended), `app/competition/page.tsx` (gains a session gate around the existing `SubmitCompetitionForm`), `app/competition/SubmitCompetitionForm.tsx` (error-mapping extended for 401), `auth.ts` (error page setting only).
- **Approach:** Header nav gains a session block: server-action forms calling `signIn("github")` / `signOut()`, showing `githubLogin` when signed in. Each submit surface awaits `auth()`: signed out → one line of copy ("Sign in with GitHub to submit an agent — we read only your public profile") + sign-in button with `redirectTo` set to that page's own path (`/submit` or `/competition`); signed in → the existing client form, which now displays the submitting identity. Both client forms map response status to distinct messages: 401 → "session expired" with a sign-in link opening a new tab (typed prompt stays in state); 429 → rate-limit copy with retry window; other errors keep current rendering (judge rejection on both; duplicate-prompt 409 additionally on the competition form, already implemented). Set Auth.js `pages.error` (or equivalent redirect) so consent-cancel lands back on whichever page initiated sign-in with a "sign-in didn't complete, try again" notice — map Auth.js's known error codes to canned copy via an allowlist; never render the raw query value.
- **Execution note:** Component tests first where the harness supports it; visual pass via browser QA at the end.
- **Patterns to follow:** inline `style={{}}` + `app/globals.css` variables; existing nav markup in `app/layout.tsx`; `app/page.test.tsx` / `app/competition/page.test.tsx` for component-test shape.
- **Test scenarios:**
  - Submit page (main arena) with no session renders sign-in prompt, not the form.
  - Submit page (main arena) with a session renders the form and the user's login.
  - Competition page with no session renders sign-in prompt in place of `SubmitCompetitionForm`; with a session renders the form and the user's login.
  - Both forms map 401 → session-expired message (prompt text still present in the textarea), 429 → rate-limit message, judge rejection → existing message; competition form additionally still maps 409 → duplicate-prompt message (unaffected by this unit).
  - Either submit page with an auth error query param shows the retry notice.
- **Verification:** Tests green; manual browser pass: sign in from header and from each submit page, cancel consent at GitHub and land back with the notice on the originating page, sign out.

### U4. Show submitter identity on public pages

- **Goal:** Main arena leaderboard, status, and run detail display `github_login` next to the agent name; competition leaderboard displays `github_login` in place of the truncated submission id.
- **Requirements:** R8, R12.
- **Dependencies:** U2, U2b.
- **Files:** `lib/leaderboard-view.ts`, `lib/status-view.ts`, `app/page.tsx`, `app/status/page.tsx`, `app/runs/[id]/page.tsx`, `lib/competition-leaderboard.ts`, `app/competition/page.tsx`, colocated view tests.
- **Approach:** Add `githubLogin` to the `LeaderboardRow` and `RecentActivityRow` view models (same join-and-fallback shape as `agentName`); render as inert text (e.g. "by login") in the leaderboard table, status rows, and the run-detail header's inline join. Add `githubLogin` to `CompetitionRow` (`lib/competition-leaderboard.ts`) the same way, joined from the submission; in `app/competition/page.tsx`'s ranked table, replace the "Entry" column's truncated `row.submissionId.slice(0, 8)` with `row.githubLogin`. Fall back per-field, not just per-record, on both surfaces: storage reads are unvalidated `JSON.parse` casts, so a submission blob that exists but lacks `github_login` (pre-wipe stray blob, or the baseline — which has no submitting user) must render an "unknown"/dash fallback rather than throw or show `undefined`. The baseline row keeps its existing "Baseline" label regardless (it was never a `github_login`-bearing entry).
- **Execution note:** Test-first on the view models.
- **Test scenarios:**
  - Main arena view models populate `githubLogin` from the joined submission.
  - Run whose submission is missing → fallback row, no throw (post-wipe safety).
  - Submission present but missing `github_login` (pre-wipe stray blob) → "unknown" fallback for the login field only.
  - Competition `CompetitionRow` populates `githubLogin` from its joined submission; ranked table renders it instead of the truncated id.
  - Competition row whose submission lacks `github_login` (pre-wipe stray, or theoretically the baseline if it ever showed here — it shouldn't, see Approach) → fallback, no throw.
- **Verification:** View/page tests green; both leaderboards render with login visible.

### U5. Blob wipe script and rollout

- **Goal:** Clean production data reset (main arena AND competition, since they share storage prefixes) and a documented path to live.
- **Requirements:** R9, R10.
- **Dependencies:** none (code); runs last operationally.
- **Files:** `scripts/wipe-blob-data.mjs` (new), `scripts/wipe-blob-data.test.mjs` (new), `README.md` or `docs/` setup note.
- **Approach:** Script lists blobs by the storage prefixes (`submissions/`, `runs/`, `events/`, traces) using `list` and deletes with `del` from `@vercel/blob` (first use of `del` in the repo); prints what it would delete by default, deletes only with `--yes`; requires `BLOB_READ_WRITE_TOKEN` and prints which store the token resolves to (first listed blob URLs) before deleting, as a wrong-target guard. Delete children first (events/traces, then runs, then submissions) so a partial failure never leaves a run pointing at a deleted submission; the script is idempotent — remediation for any partial failure is to re-run it. No competition-specific filtering — the wipe is prefix-based and competition submissions/runs live in the same prefixes, so they're removed automatically; the dry-run listing will visibly include the competition baseline and any entries, which is expected. Mirror the arg-parsing/test shape of `scripts/submit-baseline.mjs`.
- **Test scenarios:**
  - Dry run lists matching blobs and calls no delete.
  - `--yes` deletes exactly the listed prefixes and nothing else, children-first order (mocked blob client).
  - Missing token → clear failure, no partial work.
  - Delete failure mid-run → nonzero exit naming remaining prefixes; re-run completes (idempotence).
- **Verification:** Script tests green; dry run against production lists the expected blobs (main arena submissions plus the competition baseline/any entries) before anyone passes `--yes`.

---

## Scope Boundaries

**Out of scope**

- Users/accounts entity, bans, quotas — GitHub is the profile source of truth; add a users blob only when moderation needs one.
- Email collection or any scope beyond the provider defaults.
- Page-level route protection (`proxy.ts`) — only the two submission POST endpoints are gated; all GETs (including `GET /api/competition/submissions` and the admin baseline endpoint) stay as they are today.
- Rate limiting or auth on read endpoints.
- Durable (cross-instance) rate limiting — the in-memory POC limiters keep their existing ceilings, just rekeyed.
- Gating or changing `POST /api/competition/admin/baseline` (R11) — it keeps its separate admin-token authority.

**Deferred to follow-up work**

- Preview-deploy sign-in (unique `*.vercel.app` URLs can't share one OAuth callback; revisit with a GitHub App or wildcard-capable flow if previews ever need login).
- Refreshing `github_login` display after a GitHub rename.
- Preserving a typed prompt across a full OAuth redirect (sessionStorage) — current mitigation is the new-tab re-auth path in U3.
- Fully removing the now-vestigial `agent_name` field/input from either submit form or the `Submission` schema — both plans (this one and the competition plan) already chose to keep collecting it while de-emphasizing its role; outright removal is a separate cleanup.

---

## Risks & Dependencies

- **Beta dependency:** `next-auth` v5 has never shipped stable; the pin (`5.0.0-beta.32`, exact) prevents surprise regressions. Peer-dep support for Next 16 is confirmed; runtime behavior on this repo's Next fork (16.2.11) is not — U1's manual smoke is the gate, and the fallback is hand-rolled GitHub OAuth with a `jose` stateless session per the fork's own authentication guide (`node_modules/next/dist/docs/01-app/02-guides/authentication.md`).
- **Secret management:** `AUTH_SECRET` must be set per environment (differing values across envs just sign users out — acceptable). New Vercel env vars: `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`. Invariant: none of these may ever be added to the sandbox `runnerEnv` allowlist in `lib/sandbox.ts` — that allowlist is what keeps secrets away from untrusted submitted prompts.
- **Abuse economics:** minting GitHub accounts is cheap, so identity alone is a weak rate-limit key — hence the dual account+IP buckets (R3) on both surfaces. The hard backstop on spend remains the in-code run budget cap and the $25 ledger cutoff; a determined attacker burns budget, not unbounded money.
- **JWTs are irrevocable until expiry:** acceptable at this stake level; shorten `maxAge` later if needed.
- **CI runs only typecheck + test** on PRs to `dev` (this repo's CI workflow triggers only against that branch) — run lint/build locally before the PR, as this pipeline already does.
- **Wiping the competition baseline is a real operational step, not just data cleanup:** the daily contest has no reference entry to beat until the admin re-triggers it (see Operational Rollout) — do this promptly after the wipe, before announcing the login requirement.

---

## Operational Rollout (order matters)

1. Owner creates two GitHub OAuth apps in the browser (callbacks `http://localhost:3000/api/auth/callback/github` and the production callback URL); generates `AUTH_SECRET` (`npx auth secret`); sets the three vars in `.env.local` and all Vercel envs.
2. Land U1–U5 as a PR; merge to `main`.
3. Immediately before promoting to production: confirm no runs are queued or running on either surface (status page and `/competition`'s pending count both show zero in-flight), then run the wipe script dry, review the listing (main arena submissions + the competition baseline/entries) and the printed target store, run with `--yes`.
4. Promote; browser QA the full loop in production on both surfaces (sign in → submit → leaderboard shows login).
5. Re-trigger the competition baseline via `POST /api/competition/admin/baseline` (admin token) — the wipe deleted it — before the competition is usable again.

---

## Sources & Research

- `next-auth@5.0.0-beta.32` peer deps `next: ^14 || ^15 || ^16` verified via `npm view`; Next-16 peer-dep fix landed in beta.30 (nextauthjs/next-auth#13302).
- Auth.js env inference, Vercel trust-host auto-detection, callback URL shape: authjs.dev installation/deployment guides.
- GitHub provider default scopes `read:user user:email` (nextauthjs/next-auth#2579); raw `profile` only available in the `jwt` callback on initial sign-in.
- Testing seam (mock the app-local `auth.ts` module, alias-path gotcha): nextauthjs/next-auth discussion #10188 — community-sourced, no official pattern exists (#9913).
- Repo conventions: colocated Vitest tests with `vi.mock` storage seam (`lib/test-support/storage-ref.ts`); inline-style UI; view-model joins in `lib/leaderboard-view.ts` / `lib/status-view.ts` / `lib/competition-leaderboard.ts`; this Next fork replaces `middleware.ts` with `proxy.ts` and has async `cookies()`/`headers()` (`node_modules/next/dist/docs`).
- Competition surface (added 2026-07-25, after this plan's original authoring): `docs/plans/2026-07-25-001-feat-daily-prompt-competition-plan.md`, `app/api/competition/submissions/route.ts`, `lib/rate-limit.ts`, `lib/competition-leaderboard.ts`, `app/competition/page.tsx`, `app/competition/SubmitCompetitionForm.tsx` — read fresh during implementation, this plan's descriptions of them reflect their state as of the 2026-07-25 merge to `main`.
