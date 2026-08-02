---
title: "feat: Daily Prompt Competition"
date: 2026-07-25
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
plan_type: feat
---

# feat: Daily Prompt Competition

## Summary

Add a second, parallel leaderboard at `/competition`: one fixed harness (Pi — already the whole app's harness), one fixed admin-picked open-source model, one submitted prompt per entry, one run per submission (not the main arena's 5x sample). Entries rank by tasks solved (descending) then run cost (ascending tiebreak); a true tie is shown as tied, with the $100 daily prize split or paid manually by the admin, out of band. The existing main arena (`app/page.tsx`, `/api/submissions`, pass-rate-mean ranking) is untouched — this is fully additive.

## Product Contract preservation

Not applicable — no upstream requirements document exists for this feature (`product_contract_source: ce-plan-bootstrap`). This plan was authored directly from a settled-decisions brief captured in conversation.

---

## Problem Frame

The existing arena ranks prompts by mean pass rate across 5 sampled runs per submission — good for statistical confidence, but expensive (5x sandbox cost per submission) and not shaped like a head-to-head daily contest. The user wants a cheaper, simpler format: **one model, one harness, one run per entry, ranked by raw tasks-solved with cost as a tiebreak** — a discrete daily competition with a real $100 prize, paid manually by the admin to whoever tops the leaderboard when they check.

## Requirements

- **R1.** A fixed competition model (open-source, cheap) is configured once; no per-submission model choice.
- **R2.** A single admin (shared-secret gated, no OAuth) can trigger a one-time baseline run for the competition model. The result is displayed as the reference "baseline" entry.
- **R3.** Any visitor can submit a prompt to the competition. Each submission dispatches exactly one sandbox run (not 5).
- **R4.** A submission is rejected if its prompt string is byte-identical to the baseline's prompt, or to any other prompt already submitted to the competition (approved, rejected, or pending) — exact match only, not normalized. Known limitation: this check is not concurrency-safe (Vercel Blob has no unique constraint); acceptable for v1.
- **R5.** Entries rank by tasks solved descending, then total run cost ascending. Entries tied on both are visually marked as tied; the app does no prize-split math or payment.
- **R6.** The leaderboard is one single, ever-growing, cumulative list — no daily reset, no day-scoped data model. The "daily $100" is purely an out-of-band human process: the admin looks at the live board and pays whoever is #1.
- **R7.** The competition submission form still collects an agent name internally (each Submission/Run already carries its own stable id), but the public `/competition` UI does not prominently surface it — a near-term fast-follow will replace identity with GitHub OAuth login, so agent name is being intentionally de-emphasized now rather than built up as the identity axis.
- **R8.** Existing main-arena leaderboard, ranking, and submission flow (`app/page.tsx`, `/api/submissions`, `lib/aggregate.ts`) are not behaviorally changed or regressed for any non-competition submission. The one exception, required to satisfy this requirement rather than violate it: `lib/aggregate.ts`'s `aggregatePrompts` must exclude `competition === true` submissions from its grouping, or competition entries silently contaminate the main-arena leaderboard (see KTD1).

## Key Technical Decisions

**KTD1. Reuse `Submission`/`Run` types and the existing sandbox/judge/dispatch pipeline; tag competition entries with new optional boolean fields rather than forking new data types.** *(session-settled: user-directed — chosen over a separate schema/storage prefix: the existing pipeline (`lib/judge.ts`, `lib/dispatch.ts`, `lib/sandbox.ts`, `scripts/runner/runner.mjs`, the run callback route, `/runs/[id]` page) all operate on `Submission`/`Run` by id and are already harness/model-agnostic — forking new types would duplicate all of that for no benefit.)*
  - Add `competition: z.boolean().optional()` to `SubmissionSchema` — marks a submission as belonging to the competition pool (as opposed to the main arena).
  - Add `competition_baseline: z.boolean().optional()` — marks the one submission that is the competition's reference baseline. Avoids fragile string-matching on agent name (especially since R7 de-emphasizes agent name).
  - Competition runs share the main arena's global dispatch concurrency cap (`lib/dispatch.ts`'s `MAX_CONCURRENT_RUNS`) — no separate budget. Acceptable: traffic volume is low at POC stage; revisit if the two pools start starving each other.
  - **Required corollary (caught in review — was a real gap, not optional polish):** `app/page.tsx`, `/api/leaderboard` (via `lib/leaderboard-view.ts`'s `getStandings`), and `lib/aggregate.ts`'s `aggregatePrompts` all call `storage.listSubmissions()`/`listRuns()` unfiltered. Since `COMPETITION_MODEL` defaults to `zai/glm-5.2` — already the main arena's `DEFAULT_MODEL` — every competition submission would otherwise appear as a new main-arena entry, and a competition prompt byte-identical to an existing main-arena prompt on the same model would get silently averaged into that arena prompt's standing. `aggregatePrompts` must filter out `competition === true` submissions before grouping (one filter line, added where it groups by `${model} ${promptKey}` — see U1). Runs themselves stay in the shared `runs/` prefix untouched (dispatch/callback/reaper depend on `storage.getSubmission()`/`getRun()` working for any id, competition or not), so only the Submission-level aggregation needs the filter — not a storage-layer fork.

**KTD2. New ranking module, not a reuse of `lib/aggregate.ts` or `lib/leaderboard.ts`.** *(session-settled: user-directed — chosen over extending an existing ranking function: `lib/aggregate.ts`'s `aggregatePrompts` ranks by mean pass rate across N runs per prompt (built for the 5x-sample design) and `lib/leaderboard.ts`'s `sortLeaderboard`/`partitionLeaderboard` requires completing ALL tasks to rank at all — confirmed dead code today (no importers besides its own test file; the live `/api/leaderboard` route and `app/page.tsx` both call `lib/aggregate.ts`/`lib/leaderboard-view.ts`'s `getStandings`, not `lib/leaderboard.ts`). Neither matches "rank by raw tasks-solved count, cost tiebreak, ties marked" — a third, genuinely different formula.)*
  - New module `lib/competition-leaderboard.ts`: filters submissions where `competition === true`, joins each to its single run, sorts by `tasks_passed` desc then `total_cost_usd` asc, and marks any entries sharing an identical `(tasks_passed, total_cost_usd)` pair as tied.

**KTD3. Admin gate is a shared-secret env token (`COMPETITION_ADMIN_TOKEN`), checked via request header, not OAuth.** *(session-settled: user-directed — chosen over building the already-spec'd GitHub OAuth plan (`docs/plans/2026-07-22-001-feat-github-login-plan.md`) first: user explicitly said "simple secret gate" for a single admin, reserving real login for a separate fast-follow.)*

**KTD4. The competition model is a single hardcoded/env-configurable constant, not an "add a model" admin CRUD flow.** *(session-settled: user-directed, refined during planning — the settled decision was "one harness and one model," and since only one model is ever in play at a time, "admin picks a model" collapses to: an env var/constant names the model, and the admin's only action is triggering (or re-triggering, guarded against duplicates) that model's baseline run. Building a UI to add/switch models is deferred — see Scope Boundaries.)*
  - `COMPETITION_MODEL` env var, defaulting to `zai/glm-5.2` — already the app's `DEFAULT_MODEL`, already registered in `lib/models.ts`'s `ALLOWED_MODELS`, open-weight (Z.ai's GLM family), and the cheapest model in the existing palette (~$1/run per `app/submit/page.tsx`'s cost notes, vs. ~$2–3+ for the Claude models and pricier for Opus). No new provider wiring needed.

**KTD5. Dedup and ranking read the full competition submission list on every request (list-and-compare), no caching layer.** *(session-settled: user-directed — "basic, not overbuilt" per the brief; Vercel Blob has no unique constraint or transactions, so a stronger concurrency-safe dedup is out of scope for v1 per R4.)*
  - **Review call-out (does not change the decision):** review noted `lib/storage.ts` already has a stronger local pattern for this exact class of problem — `appendRunEvents` uses an atomic keyed write (`allowOverwrite: false`, retry on collision) instead of list-then-compare, because Blob's `list()` can lag even for sequential (non-concurrent) calls. That pattern (a marker blob keyed by a hash of the prompt) would close the race entirely and is barely more code than list-and-compare — a natural v2 upgrade path, noted here rather than re-litigating the settled v1 scope.
  - **Distinct issue, in scope for v1 (see U3/U4):** dedup must not treat a submission whose run infra-failed (`failed`/`reaped` — a sandbox/dispatch problem, not the submitter's fault) the same as a judge-rejected or successfully-run duplicate. Permanently blocking a prompt because of an infra failure is a real gap, not an acceptable v1 tradeoff — fixed in U3/U4 below.

**KTD6. Agent name is still collected and stored, but not displayed as the row's primary label on `/competition`.** *(session-settled: user-directed, mid-conversation — anticipates the GitHub-OAuth fast-follow replacing agent name with GitHub username as the identity axis; displaying agent name now and replacing it in a few days would just be rework. The row instead shows the submission's short id and rank.)*

---

## High-Level Technical Design

```mermaid
sequenceDiagram
    participant Admin
    participant AdminAPI as POST /api/competition/admin/baseline
    participant User
    participant SubmitAPI as POST /api/competition/submissions
    participant Judge as lib/judge.ts
    participant Storage as lib/storage.ts (shared)
    participant Dispatch as lib/dispatch.ts (shared)
    participant Page as GET /competition

    Admin->>AdminAPI: header X-Competition-Admin-Token
    AdminAPI->>Storage: any competition_baseline submission exist?
    AdminAPI->>Storage: create Submission{competition:true, competition_baseline:true,\nmodel:COMPETITION_MODEL, prompt: vanilla pi prompt}
    AdminAPI->>Storage: create 1 Run{status:queued}
    AdminAPI->>Dispatch: dispatchQueuedRuns()

    User->>SubmitAPI: {agent_name, prompt}
    SubmitAPI->>Storage: list competition submissions
    SubmitAPI->>SubmitAPI: reject if prompt === baseline.prompt\nor === any existing competition submission.prompt
    SubmitAPI->>Judge: judgeSubmission(prompt, tasks)
    SubmitAPI->>Storage: create Submission{competition:true, model:COMPETITION_MODEL}
    SubmitAPI->>Storage: create 1 Run{status:queued}
    SubmitAPI->>Dispatch: dispatchQueuedRuns()

    Page->>Storage: list competition submissions + runs
    Page->>Page: rank by tasks_passed desc, cost asc; mark ties
```

Ranking shape (per KTD2), evaluated over completed runs only:

```text
rows = competitionSubmissions
  .map(sub => join sub -> its one Run)
  .filter(row => row.run.status === "completed" && row.run.tasks_passed !== undefined)
  .sort by (tasks_passed desc, total_cost_usd asc)

rank[i] = i+1, unless (tasks_passed, total_cost_usd) == previous row's ->
  same rank as previous row, both flagged tied: true
```

---

## Output Structure

```text
lib/
  competition-config.ts            # COMPETITION_MODEL + admin token helper (new)
  competition-leaderboard.ts       # ranking + tie logic (new)
  competition-leaderboard.test.ts  # unit tests (new)
  aggregate.ts                      # + competition-submission filter (modified)
  types.ts                          # + competition, competition_baseline fields (modified)
app/
  layout.tsx                        # + "Competition" nav link (modified)
  competition/
    page.tsx                        # leaderboard (submit form in SubmitCompetitionForm.tsx) (new)
    SubmitCompetitionForm.tsx        # client submit form (new)
  api/
    competition/
      submissions/
        route.ts                    # POST submit, GET list (new)
        route.test.ts               # (new)
      admin/
        baseline/
          route.ts                  # POST trigger baseline (new)
          route.test.ts             # (new)
```

---

## Implementation Units

### U1. Extend `Submission` with competition tagging fields

**Goal:** Let a `Submission` be marked as belonging to the competition pool and, at most once, as the competition baseline — without touching any existing field or reader.

**Requirements:** R1, R2, R7 (KTD1)

**Dependencies:** None

**Files:**
- `lib/types.ts` — add `competition: z.boolean().optional()` and `competition_baseline: z.boolean().optional()` to `SubmissionSchema`.
- `lib/aggregate.ts` — filter competition submissions out of `aggregatePrompts`.

**Approach:**
1. Add the two optional fields to `SubmissionSchema` in `lib/types.ts`. Optional + absent-means-false preserves every existing reader (main arena code never sets or checks these fields, so it's unaffected).
2. **Required, not optional polish (per R8/KTD1):** in `aggregatePrompts` (`lib/aggregate.ts`), skip any submission where `competition === true` when building the grouping map — one added condition where it currently loops `for (const run of runs)` and looks up `submissionById.get(run.submission_id)`. Without this, competition entries surface on the main arena leaderboard and can collide-and-average with an identical-text main-arena prompt on the same model. This is the one deliberate touch to a main-arena file this plan makes, and it's additive (a skip condition, not a behavior change for any submission that isn't `competition === true`).

**Patterns to follow:** The existing optional-field style already used for `model`, `run_ids` (absent = legacy/default semantics, documented inline).

**Test scenarios:**
- Test expectation: none for the schema addition itself -- exercised indirectly by every other unit's tests.
- `aggregatePrompts` given a mix of `competition: true` and ordinary submissions → standings include only the ordinary ones; the competition submissions produce no row even if their prompt text or model would otherwise group them with an existing arena standing.
- Covers R8.

**Verification:** `SubmissionSchema.parse(...)` accepts objects with and without the new fields; existing submission fixtures in other test files still parse unchanged; existing `lib/aggregate.test.ts` cases remain green and a new case confirms the filter.

---

### U2. Competition ranking module

**Goal:** Given the full submission + run lists, compute the competition leaderboard rows: rank by tasks solved desc, cost asc, with ties marked.

**Requirements:** R5 (KTD2)

**Dependencies:** U1

**Files:**
- `lib/competition-leaderboard.ts` (new)
- `lib/competition-leaderboard.test.ts` (new)

**Approach:**
1. `getCompetitionEntries(storage)`: list submissions and runs, filter submissions where `competition === true`, join each to its run (a competition submission always has exactly one run per U3/U4 — take the first/only `run_ids` entry).
2. Split into `baseline` (the submission with `competition_baseline === true`, if its run is completed) and `ranked` (completed runs only, `tasks_passed` and `total_cost_usd` defined) and `pending` (queued/running) similar in spirit to the main app's `pendingRuns` concept.
3. Sort `ranked` by `tasks_passed` desc, then `total_cost_usd` asc.
4. Walk the sorted list assigning `rank`: a row whose `(tasks_passed, total_cost_usd)` exactly matches the previous row's gets the same rank and both rows get `tied: true`.

**Technical design (directional):**
```text
type CompetitionRow = {
  submissionId, runId, rank, tied: boolean,
  tasksPassed, totalTasks, totalCostUsd, submittedAt,
}
function rankCompetition(rows): CompetitionRow[]  // sort + tie-assignment described above
function getCompetitionBoard(storage): { baseline: CompetitionRow | null, ranked: CompetitionRow[], pending: number }
```

**Patterns to follow:** `lib/aggregate.ts`'s grouping/sorting style and `lib/leaderboard-view.ts`'s baseline-partitioning shape (for structure only — the ranking formula itself is new per KTD2).

**Test scenarios:**
- Two completed runs, different `tasks_passed` → higher count ranks #1.
- Two completed runs, same `tasks_passed`, different cost → lower cost ranks #1.
- Two completed runs, identical `tasks_passed` AND identical `total_cost_usd` → both rank #1 and both marked `tied: true`.
- Three-way tie → all three marked tied at the same rank; the next distinct entry ranks #4 (not #2).
- A queued/running competition run is excluded from `ranked` and counted in `pending`.
- A non-competition submission (main arena) is excluded entirely, even with a great score.
- No completed competition runs yet → `ranked` is empty, `baseline` still populates if its own run completed independently.
- Covers R5. Baseline submission's run not yet completed → `baseline` is `null` (don't show a partial/undefined baseline row).

**Verification:** Unit tests above pass; a manual `getCompetitionBoard` call against fixture storage produces the expected order and tie flags.

---

### U3. Admin baseline-trigger endpoint

**Goal:** Let the admin (shared-secret gated) trigger the one-time baseline run for `COMPETITION_MODEL`, reusing the existing baseline-prompt text and submission/dispatch pipeline.

**Requirements:** R2 (KTD3, KTD4)

**Dependencies:** U1

**Files:**
- `app/api/competition/admin/baseline/route.ts` (new)
- `app/api/competition/admin/baseline/route.test.ts` (new)
- `lib/competition-config.ts` (new) — exports `COMPETITION_MODEL` (env-overridable, default `zai/glm-5.2`) and `COMPETITION_ADMIN_TOKEN` read helper.

**Approach:**
1. `lib/competition-config.ts`: `export const COMPETITION_MODEL = process.env.COMPETITION_MODEL ?? "zai/glm-5.2"`, validated against `isAllowedModel` at import time (throw on an invalid override — fail fast at boot, not silently at request time).
2. `POST /api/competition/admin/baseline`: read `X-Competition-Admin-Token` header, compare to `process.env.COMPETITION_ADMIN_TOKEN` (constant-time compare, e.g. `crypto.timingSafeEqual` on fixed-length buffers, or a simple equality check with a comment noting timing-attack exposure is acceptable at POC scale — implementer's call). Reject with 401 if missing/mismatched, and 500 with a clear message if `COMPETITION_ADMIN_TOKEN` isn't configured (never treat an unset token as "no auth required"). Apply the same per-IP rate limiter pattern used in U4 to this endpoint too — nothing else in the plan throttles repeated token-guessing attempts.
3. Check for an existing `competition_baseline: true` submission whose run is `queued`, `running`, or `completed` (reuse `storage.listSubmissions()`, filter). If one exists, return 409 rather than creating a duplicate (mirrors `scripts/submit-baseline.mjs`'s `--confirm`-once guard, moved server-side). If the only prior baseline submission's run ended `failed`/`reaped` (infra failure) or the submission itself was judge-`rejected`, do NOT count it as blocking — allow a fresh baseline attempt (an infra hiccup or an unexpected rejection must not permanently prevent the competition from ever having a baseline).
4. Read the vanilla prompt from the existing `docs/pi-vanilla-system-prompt.txt` (same file `GET /api/baseline-prompt` already serves — read directly via `node:fs`, or call the existing route handler's file-read logic; do not re-fetch over HTTP from within the same app).
5. Create the `Submission` (`competition: true, competition_baseline: true, model: COMPETITION_MODEL`) and judge it via `judgeSubmission` like any other submission — no special-casing. It's expected to pass, but the code path stays uniform (see the rejection test scenario below).
6. Create exactly 1 `Run` (`status: "queued"`, `model: COMPETITION_MODEL`), append the `run.created` event, kick `dispatchQueuedRuns(storage)` the same way `/api/submissions` does (via `after()` with a direct-call fallback).

**Patterns to follow:** `app/api/submissions/route.ts`'s submission/run creation and dispatch-kick block (`after()` + fallback); `scripts/submit-baseline.mjs`'s duplicate-guard intent.

**Test scenarios:**
- Missing/incorrect admin token → 401, no submission created.
- `COMPETITION_ADMIN_TOKEN` unset on the server → 500, explicit config-error message, no silent bypass.
- Valid token, no existing baseline → creates submission + 1 run, dispatch is kicked, response includes the new submission/run id.
- Valid token, baseline already exists with a queued/running/completed run → 409, no second submission created.
- Valid token, a prior baseline submission's run ended `failed` or `reaped` → treated as no existing baseline; a fresh baseline submission + run is created.
- Valid token, a prior baseline submission was judge-`rejected` → treated as no existing baseline; a fresh attempt is created.
- Repeated invalid-token attempts within the rate-limit window → 429, same as U4's limiter.
- Covers R2. Judge rejects the vanilla prompt (should not happen, but the code path must handle it) → submission stored with `status: "rejected"`, no run created, response reflects rejection rather than throwing.

**Verification:** Route tests above pass against `MemoryStorage`; a manual curl with a wrong token returns 401.

---

### U4. Competition submission endpoint (with dedup)

**Goal:** Accept a `{agent_name, prompt}` submission, enforce exact-match dedup against the baseline and all existing competition submissions, then create one queued run.

**Requirements:** R3, R4 (KTD1, KTD4, KTD5, KTD6)

**Dependencies:** U1, U3 (baseline must exist for a meaningful dedup check, though technically not a hard runtime dependency — dedup itself reads `storage.listSubmissions()` directly, it does not call anything from U2's ranking module)

**Files:**
- `app/api/competition/submissions/route.ts` (new) — `POST` (submit), `GET` (list, for the page/debugging)
- `app/api/competition/submissions/route.test.ts` (new)

**Approach:**
1. Validate input: `agent_name` (1–40 chars, same bounds as the main arena), `prompt` (max chars, same `MAX_PROMPT_CHARS` constant or a local copy). No `model` field accepted — always `COMPETITION_MODEL`.
2. Rate-limit: reuse the same per-IP in-memory limiter pattern as `app/api/submissions/route.ts` (explicitly POC-level, already precedented), AND key a second limiter bucket on `agent_name` (same window/threshold, same in-memory `Map` pattern). A real cash prize plus single-run (non-averaged) scoring makes per-IP-only throttling too easy to route around (VPN/mobile-network IP rotation); the extra key is a few lines reusing the existing pattern, not new infrastructure.
3. Dedup check: `storage.listSubmissions()`, filter `competition === true`, compare `prompt` (exact `===`, no trim/normalize per KTD5/R4) against every existing competition submission's prompt, INCLUDING the baseline's prompt. Reject with 409 and a clear message ("this prompt has already been submitted") if any match. A match counts regardless of the other submission's judge outcome (approved or rejected) — but NOT if that submission's only run ended `failed`/`reaped` (infra failure): an infra failure is not the submitter's fault and must not permanently burn their prompt (see KTD5). Add a `ponytail:`-style comment noting this is exact-match only (no whitespace/case normalization) and not concurrency-safe (a read-then-write race under Blob's eventual consistency) — acceptable v1 scope per KTD5.
4. Judge the prompt via `judgeSubmission` (reused from `lib/judge.ts`), same flow as `app/api/submissions/route.ts`.
5. On approval: create `Submission{competition: true, model: COMPETITION_MODEL, agent_name, prompt, status: "queued"}`, create exactly 1 `Run` (not `RUNS_PER_SUBMISSION`), append `run.created` event, kick `dispatchQueuedRuns(storage)`.
6. On rejection: store the rejected submission as-is (it still counts for future dedup per step 3) and return the judge's reason, same shape as the main arena's response.
7. `GET`: returns competition submissions with `status` in `queued`/`running`/`scored`/`failed` only (excludes `rejected` — a fraud-judge-rejected prompt may contain flagged jailbreak/injection text and should not be echoed back to anonymous callers), and never includes the raw `prompt` field in the response — matches the existing `/api/leaderboard` precedent of not exposing prompt text (`lib/leaderboard-view.ts`'s route comment: "Prompt text itself isn't exposed here"). This endpoint backs debugging/inspection, not the `/competition` page itself (U5 reads via `getCompetitionBoard(storage)` directly, server-side).

**Patterns to follow:** `app/api/submissions/route.ts` almost line-for-line, minus the model selector and minus the `RUNS_PER_SUBMISSION` loop (hardcoded to 1 run).

**Test scenarios:**
- Valid new prompt → submission + 1 run created, dispatch kicked, response has `submission_id` and `run_id`.
- Prompt byte-identical to the baseline's prompt → 409, no submission created.
- Prompt byte-identical to another already-submitted (approved) competition prompt → 409.
- Prompt byte-identical to another submission's prompt that was itself rejected → still 409 (dedup applies regardless of judge outcome).
- Prompt byte-identical to another submission's prompt whose run ended `failed`/`reaped` (infra failure) → NOT rejected; a fresh submission is accepted (infra failure does not permanently burn a prompt).
- Prompt differing only by trailing whitespace from an existing one → NOT rejected (exact-match only, per R4/KTD5 — this is the documented v1 limitation, not a bug).
- Judge rejects a genuinely novel prompt → submission stored `status: "rejected"`, no run created, reason surfaced in the response.
- Rate limit exceeded by IP → 429.
- Rate limit exceeded by `agent_name` (different IP, same name) → 429.
- A main-arena submission with the identical prompt text does NOT block a competition submission (dedup scope is competition-only, per KTD1/R8 — the two pools are independent).
- `GET` response excludes rejected submissions and never includes raw `prompt` text.
- Covers R3, R4.

**Verification:** Route tests above pass; manually POSTing the same prompt twice in a row returns 409 on the second call.

---

### U5. `/competition` leaderboard + submit page

**Goal:** A single page showing the baseline, ranked entries (with ties visually obvious), pending-run count, and a submit form — model fixed, agent name collected but not the row's primary display label.

**Requirements:** R1, R5, R6, R7 (KTD2, KTD4, KTD6)

**Dependencies:** U2, U3, U4

**Files:**
- `app/competition/page.tsx` (new) — server component, mirrors `app/page.tsx`'s data-fetch + table shape.
- `app/competition/SubmitCompetitionForm.tsx` (new) — client component, mirrors `app/submit/page.tsx`'s form minus the model selector.
- `app/layout.tsx` — add a "Competition" nav link alongside the existing Leaderboard/How it works/Submit/Voice links. Without this the page is only reachable by typing the exact URL, which the public-submission requirement (R3) depends on.

**Approach:**
1. Server component calls `getCompetitionBoard(storage)` (from U2), revalidates on an interval (match `app/page.tsx`'s `revalidate = 15`).
2. Baseline row rendered distinctly above the ranked table (labeled "Baseline," not by agent name), with three distinct states rather than one collapsed "not shown yet" case:
   - No `competition_baseline` submission exists yet → "Baseline not triggered yet."
   - One exists but its run hasn't completed → "Baseline running…"
   - One exists but was judge-rejected → surface the judge's reason visibly (this is the admin's only signal that the baseline trigger needs attention — without it, the reference entry silently never appears with no explanation).
3. A short line of copy explaining why this leaderboard's ranking differs from the main arena's (single run, tasks-solved-then-cost, one fixed model) — both compete on the same public task set, so an unexplained second ranking formula would be confusing.
4. Ranked table columns: Rank (showing "Tied for #N" when `tied`), a short id-based label (e.g. first 8 chars of `submissionId`) instead of agent name per R7/KTD6, Tasks solved (`x/total`), Total cost, submitted-at.
5. Zero ranked entries (baseline may still be populated) → explicit placeholder copy (e.g. "No entries yet — beat the baseline"), distinct from the fully-empty state.
6. Pending count shown similarly to the main arena's `pendingRuns` link, if any competition runs are still queued/running.
7. Submit form: agent name (still required, stored, not displayed elsewhere on this page), prompt textarea with the same char-limit UX as `app/submit/page.tsx`; no model selector (fixed model shown as static text, e.g. "Model: glm-5.2 (fixed for this competition)"). "Start from the baseline prompt" button reused (fetches the same `/api/baseline-prompt` — content is model-agnostic, it's the vanilla pi prompt text) so users see what they need to beat.
8. On submit, POST to `/api/competition/submissions`; render the judge verdict inline via the same `parseSubmitResponse` pattern as `app/submit/page.tsx`, PLUS an explicit check for HTTP 409 (duplicate prompt) so it renders under a distinct "Prompt already submitted" heading rather than falling into `parseSubmitResponse`'s generic non-2xx "Couldn't submit" bucket (409 isn't a judge verdict or a system failure — it's a deterministic, expected outcome and deserves its own copy).

**Patterns to follow:** `app/page.tsx` (data-fetch, table layout, pending-runs link) and `app/submit/page.tsx` (form layout, submit/error/result handling) almost verbatim, trimmed down.

**Test scenarios:**
- Empty leaderboard (no completed runs yet) → page renders an empty-state message and still shows the submit form, mirroring `app/page.tsx`'s empty state.
- No baseline submission exists yet → "Baseline not triggered yet" state, not a blank/missing section.
- Baseline submission exists, run still queued/running → "Baseline running…" state.
- Baseline submission exists but was judge-rejected → judge's rejection reason is visibly surfaced.
- Baseline present, no competitor entries yet → baseline row renders, ranked table shows the explicit placeholder copy (not the main arena's fully-empty copy).
- Two tied entries at rank 1 → both rows show "Tied for #1" (or equivalent), not "#1" and "#2".
- Submitting a duplicate prompt → distinct "Prompt already submitted" heading (not the generic "Couldn't submit" heading), no navigation/crash.
- Submitting a valid new prompt → success state shows submission id and a link to `/runs/[id]` (existing run detail page, reused as-is).
- Global nav includes a working link to `/competition`.
- Covers R5, R6, R7.

**Verification:** Manual browser walk of `/competition`: view empty state, submit a prompt, see it appear (pending, then ranked once the sandbox completes or via a seeded fixture in dev), attempt a duplicate submission and see the rejection.

---

### U6. Config wiring and docs note

**Goal:** Make `COMPETITION_MODEL` and `COMPETITION_ADMIN_TOKEN` discoverable and documented; note the fast-follow GitHub-identity plan doesn't require any change here yet.

**Requirements:** R1, R2 (KTD3, KTD4)

**Dependencies:** U3

**Files:**
- `.env.example` (or equivalent env-documentation file, if one exists — check repo root) — add `COMPETITION_MODEL` and `COMPETITION_ADMIN_TOKEN` with one-line comments.

**Approach:**
1. Add the two env vars with short comments (default model, "shared secret for the competition admin endpoint — keep private").
2. No code changes beyond documentation; `lib/competition-config.ts` (U3) already implements the defaulting/validation logic.

**Test scenarios:**
- Test expectation: none -- documentation only.

**Verification:** `.env.example` (or equivalent) lists both vars; a fresh clone following it can run the admin endpoint after setting `COMPETITION_ADMIN_TOKEN`.

---

## Scope Boundaries

**In scope:** Everything in Requirements R1–R8 and Implementation Units U1–U6 above.

**Deferred to Follow-Up Work:**
- GitHub OAuth login replacing agent name with GitHub username as the leaderboard identity (explicitly called out by the user as a near-term fast-follow; the existing unimplemented plan at `docs/plans/2026-07-22-001-feat-github-login-plan.md` is the likely starting point). This plan's R7/KTD6 (de-emphasize agent name now) is deliberately positioned to make that follow-up cheaper, not to build any part of it now.
- Fuzzy/normalized (whitespace/case-insensitive) or concurrency-safe duplicate-prompt detection (R4/KTD5 explicitly scope this out for v1).
- An admin UI/CRUD flow for adding or switching models (KTD4 collapses this to a single env-configured constant + one baseline-trigger action).
- Any payment/prize-split automation (R5/R6 — the admin pays manually, out of band, always).
- Daily reset or day-scoped leaderboard data modeling (R6 — one cumulative board, forever).

**Outside this product's identity:** A separate harness (only Pi is supported, app-wide) or a second simultaneous competition model.

## Open Questions

- Exact UI copy/microcopy for `/competition` beyond the structural conventions mirrored from `app/page.tsx`/`app/submit/page.tsx` — left to implementation-time judgment, consistent with existing tone.
- Whether `COMPETITION_ADMIN_TOKEN` comparison should use `crypto.timingSafeEqual` or a plain `===` — flagged in U3 as an implementer judgment call; either is acceptable at current POC scale (single admin, low traffic).

## System-Wide Impact

- Shared resources touched by this feature: `lib/dispatch.ts`'s global concurrency cap (competition runs compete for the same slots as main-arena runs — acceptable at current traffic, revisit if either pool starves); `lib/storage.ts`'s Blob backend (new submissions simply add more JSON blobs under the existing `submissions/`/`runs/` prefixes, tagged by the new optional fields — no schema migration needed since the fields are optional).
- One deliberate touch to a main-arena file: `lib/aggregate.ts`'s `aggregatePrompts` gains a filter excluding `competition === true` submissions (see U1). This is required to satisfy R8, not a violation of it — without it, competition entries leak into the main arena's leaderboard. No other change to `app/page.tsx`, `/api/submissions`, or any other main-arena-facing code path.
- Long-lived risk, accepted rather than engineered around: `COMPETITION_MODEL` is fixed and validated only against the app's current allowlist at boot. Because R6 commits to one cumulative leaderboard indefinitely, if the underlying gateway model is ever deprecated or renamed, detecting that and re-pointing the env var is a manual, out-of-band admin responsibility — consistent with how the admin already manually manages payouts and baseline triggers, not a gap to build tooling for now.

---

## Verification Contract

- All new unit/route tests listed per-unit above pass (`lib/competition-leaderboard.test.ts`, `app/api/competition/admin/baseline/route.test.ts`, `app/api/competition/submissions/route.test.ts`).
- Existing test suite (main arena) remains green — no regressions to `lib/aggregate.ts`, `lib/leaderboard.ts`, `app/api/submissions/route.test.ts`, etc.
- Manual browser walk of `/competition`: admin triggers baseline (via curl/admin token), a prompt is submitted and appears pending then ranked, a duplicate submission is rejected, ties render distinctly.

## Definition of Done

- U1–U6 implemented and tested.
- `/competition` is reachable from global nav, shows the baseline once triggered (with distinct copy for not-yet-triggered / running / rejected), accepts new prompt submissions, ranks by tasks-solved-then-cost with ties marked, and rejects exact-duplicate prompts with a distinct "already submitted" message.
- `lib/aggregate.ts`'s main-arena standings never include a `competition === true` submission (verified by test) — main arena behavior is otherwise unchanged (existing test suite stays green).
- A submission whose only run infra-failed (`failed`/`reaped`) does not permanently block resubmission of the identical prompt, and does not permanently block a fresh baseline attempt.
- `.env.example` (or equivalent) documents the two new env vars.
