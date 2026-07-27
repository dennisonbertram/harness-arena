---
title: "refactor: make the competition page the homepage and move the arena leaderboard to /benchmarks"
type: refactor
status: active
date: 2026-07-27
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# refactor: make the competition page the homepage and move the arena leaderboard to /benchmarks

## Summary

Swap the site's two leaderboards. `/competition` becomes `/` (the homepage), and
the current homepage — the arena benchmark leaderboard with the scatter chart and
per-task pass-rate panel — moves to `/benchmarks`. Every internal link that today
points at `/` meaning "the arena leaderboard" is repointed at `/benchmarks`; links
that mean "home" stay on `/`. `/competition` keeps working via a permanent
redirect so already-shared links do not break.

This is an information-architecture change only. No page content, data fetching,
aggregation, or styling changes.

---

## Problem Frame

The competition is the thing the site is currently about, but it lives one click
deep at `/competition` while the arena benchmark leaderboard occupies `/`. A
visitor landing on the site sees the benchmark table first.

The complication is that `href="/"` is used at six sites in the codebase with two
different meanings, and only some of them should follow the arena leaderboard to
its new path:

| Site | Current meaning | After |
| --- | --- | --- |
| `app/layout.tsx:49` (brand wordmark) | home | stays `/` |
| `app/layout.tsx:53` ("Leaderboard" nav) | arena leaderboard | `/benchmarks` |
| `app/tasks/[taskId]/page.tsx:25` ("← Leaderboard") | arena leaderboard | `/benchmarks` |
| `app/pending/page.tsx:38` ("← Leaderboard") | arena leaderboard | `/benchmarks` |
| `app/pending/page.tsx:43` (prose "the leaderboard") | arena leaderboard | `/benchmarks` |
| `app/auth-error/page.tsx:28` ("go home") | home | stays `/` |

Getting this table wrong is the main way this change breaks navigation, so it is
enumerated here rather than left to implementation judgment.

---

## Requirements

- R1. `/` renders the competition page (current `app/competition/page.tsx`
  content) with its ISR revalidate of 15s preserved.
- R2. `/benchmarks` renders the arena leaderboard (current `app/page.tsx`
  content) with its ISR revalidate of 15s preserved.
- R3. `/competition` permanently redirects (308) to `/` so existing shared links
  and the "view the leaderboard" link inside the submission form keep working.
- R4. Every internal link that means "the arena leaderboard" points at
  `/benchmarks`; links that mean "home" continue to point at `/` (see the table
  in Problem Frame).
- R5. The top nav offers a labelled way to reach the arena leaderboard. The
  separate "Competition" nav entry is dropped, since `/` is now the competition
  and the brand wordmark already links there.
- R6. Both pages' existing test suites still pass at their new locations.

---

## Out of Scope

- Any change to page content, layout, styling, copy, or data fetching on either
  page. Only file location, route paths, link targets, and nav labels change.
- Redesigning the nav beyond the label/target edits R4 and R5 require.
- `app/skill.md/route.ts` — grepped, it names no site routes, so it needs no edit.
- Adding a `/` → anything redirect. `/` still exists; it just shows a different
  page.

---

## Key Technical Decisions

**KTD1 — Move only the two `page.tsx` files; leave the competition components
where they are.**
`app/competition/CompetitionLeaderboardTable.tsx` and `SubmitCompetitionForm.tsx`
import `../GithubAvatar`, `../tableStyles`, and `../github-sign-in-button`, all of
which resolve to `app/`. Leaving those two components in `app/competition/` keeps
every one of those relative imports correct and keeps their git history intact;
the new `app/page.tsx` reaches them as `./competition/...`.
*Rejected:* moving the components up to `app/` alongside the page, which would
rewrite their imports and blur the boundary between competition-specific
components and the shared ones (`GithubAvatar`, `tableStyles`) already at `app/`.
*Accepted wart:* `app/competition/` survives as a directory with no `page.tsx`.
That is not a route and does not conflict with the R3 redirect.

**KTD2 — Redirect `/competition` in `next.config.ts`, not with a page-level
`redirect()` call.**
A config redirect is a real 308 issued before routing, costs no render, and is
the documented mechanism for a moved route (verified against the vendored Next.js
16 docs in `node_modules/next/dist/docs/`). A `redirect()` inside a surviving
`app/competition/page.tsx` would keep a route alive purely to bounce off it.

**KTD3 — Nav becomes Benchmarks / How it works / Submit / Voice.**
"Leaderboard" is relabelled "Benchmarks" and repointed, and the "Competition"
entry is removed rather than repointed at `/`, because the brand wordmark to its
left already goes there and two adjacent nav items pointing at `/` reads as a bug.
*Rejected:* keeping a "Competition" entry pointing at `/`.

---

## Implementation Units

Sequencing matters: U1 must land before U2, because both pages' test files are
named `page.test.tsx` and U2 writes into the slot U1 vacates.

### U1 — Move the arena leaderboard to `/benchmarks`
*Satisfies R2.*

- `git mv app/page.tsx app/benchmarks/page.tsx`
- `git mv app/page.test.tsx app/benchmarks/page.test.tsx`
- In `app/benchmarks/page.tsx`, rewrite the five sibling imports from `./` to
  `../`: `RerunButton`, `ScatterChart`, `GithubAvatar`, `ModelLogo`,
  `tableStyles` (lines 11–15 today). The `@/lib/*` imports are path-aliased and
  need no change.
- `app/benchmarks/page.test.tsx` needs **no** import edits: its only relative
  import is `./page`, which still resolves because the test moves with the page.
  Its other imports are `vitest` and `@/`-aliased.
- `export const revalidate = 15` stays.

**Test scenarios** (existing `app/benchmarks/page.test.tsx`, adapted):
- The suite that currently asserts `revalidate === 15` passes unchanged at the
  new path.
- Existing rendering/aggregation assertions pass unchanged.

### U2 — Promote the competition page to `/`
*Satisfies R1.*

- `git mv app/competition/page.tsx app/page.tsx`
- `git mv app/competition/page.test.tsx app/page.test.tsx`
- In the new `app/page.tsx`, rewrite the three relative imports:
  `../github-sign-in-button` → `./github-sign-in-button`,
  `./CompetitionLeaderboardTable` → `./competition/CompetitionLeaderboardTable`,
  `./SubmitCompetitionForm` → `./competition/SubmitCompetitionForm`.
- `app/page.test.tsx` needs **no** import edits: its only relative import is
  `./page`, which still resolves because the test moves with the page. Its
  `vi.mock` targets (`@/lib/storage`, `@/auth`) are path-aliased.
- `export const revalidate = 15` stays.
- Leave `app/competition/CompetitionLeaderboardTable.tsx`,
  `CompetitionLeaderboardTable.test.tsx`, and `SubmitCompetitionForm.tsx`
  untouched (KTD1).

**Test scenarios** (existing `app/page.test.tsx`, adapted):
- Existing competition-page assertions pass unchanged at the new path.
- `app/competition/CompetitionLeaderboardTable.test.tsx` still passes with no
  edits — proof the component directory was genuinely left alone.

### U3 — Redirect `/competition` → `/`
*Satisfies R3.*

- `next.config.ts`: add an async `redirects()` returning a single entry
  `{ source: "/competition", destination: "/", permanent: true }`.

**Test scenarios:** none automated. Config redirects are not exercised by the
unit test runner; verify in the browser smoke (see Verification).

### U4 — Repoint internal links and relabel the nav
*Satisfies R4, R5.*

- `app/layout.tsx:53`: `<Link href="/">Leaderboard</Link>` →
  `<Link href="/benchmarks">Benchmarks</Link>`.
- `app/layout.tsx:56`: remove the `<Link href="/competition">Competition</Link>`
  entry.
- `app/layout.tsx:49`: brand wordmark — unchanged.
- `app/tasks/[taskId]/page.tsx:25`: `href="/"` → `href="/benchmarks"`, label
  "← Leaderboard" → "← Benchmarks".
- `app/pending/page.tsx:38` and `:43`: both `href="/"` → `href="/benchmarks"`.
  Line 38's label becomes "← Benchmarks"; line 43's inline prose stays reading
  naturally.
- `app/auth-error/page.tsx:28`: `href="/"` — unchanged (means home).
- `app/competition/SubmitCompetitionForm.tsx:177`: `href="/competition"` →
  `href="/"`. This is the one edit inside `app/competition/`; the redirect in U3
  would cover it, but an internal link should not rely on a redirect.

**Test scenarios:** none automated — these are static hrefs with no existing link
coverage, and adding a nav snapshot test for a four-item list is not worth the
brittleness. Verified in the browser smoke.

---

## Verification

Automated, after U1–U4:
- `npm run typecheck` — catches every broken relative import from the two moves.
- `npm run lint`
- `npm test` — the full suite, since U1/U2 move test files.

Browser smoke (per the repo's UI-change practice), against the local dev server:
- `/` shows the competition leaderboard.
- `/benchmarks` shows the arena leaderboard, scatter chart, and per-task panel.
- `/competition` lands on `/` (308).
- Nav reads Benchmarks / How it works / Submit / Voice; "Benchmarks" goes to
  `/benchmarks`; the wordmark goes to `/`.
- `/pending` and a task page's back-links land on `/benchmarks`.
- Browser console clean on both pages.

---

## Risks

- **A missed `href="/"`.** Mitigated by the exhaustive six-site table in Problem
  Frame — it is the full grep result, not a sample. Re-grep after U4 to confirm
  only the two intended sites remain.
- **Test-file name collision during the moves.** Mitigated by the U1-before-U2
  ordering stated above.
- **External links to `/` expecting the benchmark leaderboard** now land on the
  competition. This is the intended product change, not a regression; no redirect
  can distinguish the two audiences.

---

## Assumptions

Recorded because they were inferred, not stated by the user:
- "A page under 'benchmarks'" means the path `/benchmarks` with a nav entry
  labelled "Benchmarks" — not a nested section with children.
- Dropping the standalone "Competition" nav entry is acceptable given the brand
  wordmark links to `/` (KTD3). If the user wants an explicit "Competition" link,
  it is a one-line add.
