---
title: "feat: redesign the competition leaderboard rows"
type: feat
status: active
date: 2026-07-26
---

# feat: redesign the competition leaderboard rows

## Summary

Redesign `/competition`'s ranked leaderboard table with three inspiration-driven
improvements the user approved after a Mobbin + mlx.fast design review: highlight
the signed-in user's own row, replace the row's direct navigation to `/runs/[id]`
with a click-to-peek modal, and restructure each row so entrant identity (GitHub
avatar + login) sits together on the left with tasks-solved as the bold primary
metric and cost as a smaller secondary line underneath. Scope is the leaderboard
table only — the baseline card, the submission form, and the main arena
leaderboard (`app/page.tsx`) are unchanged.

---

## Problem Frame

The current `/competition` leaderboard (`app/competition/page.tsx`) renders a plain
five-column table (Rank, Entrant, Tasks solved, Cost, Submitted) where every row
looks the same regardless of who is signed in, and clicking a row's rank or login
navigates straight to `/runs/[id]`, leaving the leaderboard. Reviewing mlx.fast's
leaderboard (row anatomy: avatar + handle + badges on the left, a bold primary
metric with a muted secondary line underneath, click-row-to-open-modal with stat
cards) and Duolingo/Brilliant's current-user-row-highlighting pattern on Mobbin
surfaced three concrete, low-risk improvements to this table specifically.

---

## Requirements

- R1. The signed-in user's own row in the ranked table (matched by `githubLogin`)
  is visually distinguished (background tint) from other rows. No highlight
  applies when signed out, or when the signed-in user has no row.
- R2. Clicking a row opens a modal showing that entry's rank, GitHub avatar +
  login, tasks passed/total, cost, and submitted date, plus a "View full run"
  link to `/runs/[runId]`. The row no longer navigates away directly.
- R3. Each row shows the entrant's GitHub avatar next to their login on the left.
  Tasks solved renders as the bold primary metric with cost as a smaller
  secondary line underneath it, replacing today's two flat, equal-weight
  columns. Rank 1 (including every row tied for rank 1) carries a crown/trophy
  marker.
- R4. The row stays keyboard-operable (focusable, Enter/Space opens the modal)
  since it no longer relies on a native `<a>`/`<Link>` for its primary action.
- R5. The baseline card, `SubmitCompetitionForm`, and the main arena leaderboard
  are unchanged by this work.

---

## Key Technical Decisions

- **GitHub avatars via the public `github.com/<login>.png` URL, no new data
  field.** `CompetitionRow` already carries `githubLogin`; GitHub serves a
  stable avatar at `https://github.com/<login>.png` for any real login with no
  auth or extra fetch required. Skip rendering a real avatar for the `"unknown"`
  fallback login (pre-login stray blobs) — that string is not a real GitHub
  user, and hitting `github.com/unknown.png` would show *a* real account's
  avatar, not a placeholder. Render a neutral placeholder glyph for `"unknown"`
  instead.
- **The peek modal follows `app/runs/[id]/CompletePromptModal.tsx`'s existing
  pattern** (`role="dialog"`, `aria-modal`, Escape-key close, backdrop-click
  close via `stopPropagation` on the inner panel) rather than inventing a new
  modal shape — zero new interaction pattern for the codebase to carry.
- **Row click target keeps its native `<tr>` role — no `role="button"`
  override.** The table stays a real `<table>`/`<tr>`/`<td>` structure (KTD
  below), so the `<tr>` gets `tabIndex={0}`, `onClick`, and `onKeyDown` (Enter
  and Space) to become keyboard-operable, but its implicit ARIA `row` role is
  left alone — overriding it to `role="button"` would break the row/cell
  navigation chain assistive tech builds on top of native table semantics, per
  design-lens and feasibility review of this plan's first draft (both
  independently flagged the conflict). `onKeyDown`'s Space branch calls
  `preventDefault()` so the page doesn't scroll on activation, matching what a
  native `<button>` gets for free. `(session-settled: user-approved — the
  user's own proposal explicitly asked to replace the row's direct navigation
  to /runs/[id] with a click-to-peek modal, accepting the loss of native
  middle-click/"open in new tab" on the row itself in exchange; the modal's
  "View full run" link still reaches the full page.)`
- **Baseline card and submission form are out of scope.** `(session-settled:
  user-approved — the approved proposal named the ranked table specifically;
  the baseline row isn't part of `board.ranked` and wasn't mentioned.)`
- **New client component, not an inline change to `page.tsx`.** The row
  redesign and modal both need client-side state (`useState` for the open
  row), so the table moves into a new `app/competition/CompetitionLeaderboardTable.tsx`
  client component, mirroring how `SubmitCompetitionForm.tsx` is already
  extracted as a sibling client component. `page.tsx` stays a server component
  that fetches `board` and `session` and passes plain data down.
- **Avatar `<img>` gets an `alt` and an `onError` fallback to the same
  placeholder used for `"unknown"`.** `alt={row.githubLogin}` covers screen
  readers; `onError` swapping to the placeholder glyph covers a real GitHub
  account whose avatar 404s (renamed/deleted since the row was recorded) —
  cheap to add alongside the `"unknown"`-login placeholder path already
  planned, so no login ever renders a permanently broken image.
- **The current-user row highlight (R1) matches on the row's stored
  `githubLogin`, which can go stale if the user renames their GitHub account
  between submitting and a later visit.** Accepted as a known, low-impact
  limitation rather than fixed: the failure mode is simply "no highlight" (not
  a wrong highlight), and fixing it would need a stable identifier
  (`github_id`) added to `CompetitionRow`, which the Scope Boundaries below
  deliberately excludes.

---

## Implementation Units

### U1. Extract and redesign the leaderboard table (static shape)

- **Goal:** Move the ranked table into a new client component with the
  redesigned row layout (avatar + login left, bold tasks-solved primary metric
  with cost secondary line, crown on rank 1) and current-user row highlighting.
  No modal yet — this unit lands the visual shape.
- **Requirements:** R1, R3, R5.
- **Dependencies:** none.
- **Files:** `app/competition/CompetitionLeaderboardTable.tsx` (new),
  `app/competition/CompetitionLeaderboardTable.test.tsx` (new),
  `app/competition/page.tsx`, `app/competition/page.test.tsx`.
- **Approach:**
  1. Create `CompetitionLeaderboardTable` as a `"use client"` component
     accepting `ranked: CompetitionRow[]` and `currentGithubLogin: string
     | undefined` as props — no data fetching of its own.
  2. Keep the outer `<table>`/`<thead>`/`<tbody>` structure (five logical
     columns collapse to: Rank, Entrant, Tasks solved + cost, Submitted — drop
     the separate Cost column header since cost moves under tasks-solved).
  3. Per row: render the GitHub avatar (`https://github.com/<login>.png`,
     `alt={row.githubLogin}`, an `onError` handler swapping to the same
     placeholder used for `"unknown"`) beside the login; render
     `tasksPassed/totalTasks` as the bold primary text with
     `formatUsd(totalCostUsd)` as a smaller line underneath; render a
     crown/trophy marker when `row.rank === 1`; keep the existing "Tied for
     #N" label text for tied rows. Give the row a hover/focus-visible style
     (e.g. cursor: pointer plus a subtle background/outline) distinct from
     the current-user highlight in step 4, so the two don't visually collide
     on the signed-in user's own row.
  4. Apply a distinct background style to the row where `row.githubLogin ===
     currentGithubLogin` (only when `currentGithubLogin` is defined).
  5. In `page.tsx`, replace the inline `<table>` JSX with
     `<CompetitionLeaderboardTable ranked={board.ranked} currentGithubLogin={githubLogin} />`,
     keeping the existing empty-state ("No entries yet — beat the baseline.")
     and pending-count paragraph exactly as they render today.
  6. `app/competition/page.test.tsx` today has no row-level assertions (only
     ISR-revalidate and sign-in-gating tests) — nothing to move. Write the new
     row-rendering test scenarios below directly against
     `CompetitionLeaderboardTable.test.tsx`; leave `page.test.tsx`'s existing
     two tests as they are.
- **Patterns to follow:** `app/competition/SubmitCompetitionForm.tsx` for the
  sibling-client-component extraction shape; existing `cellStyle`/`numCellStyle`
  inline-style constants in `app/competition/page.tsx`.
- **Test scenarios:**
  - Renders an avatar `<img>` with `src="https://github.com/<login>.png"` for
    a row with a real `githubLogin`.
  - Renders no real-avatar `<img src="https://github.com/unknown.png">` for a
    row whose `githubLogin` is `"unknown"` — the placeholder path renders
    instead.
  - The avatar `<img>` for a real `githubLogin` carries `alt={row.githubLogin}`
    and an `onError` handler; simulating an error event on it swaps in the
    same placeholder used for `"unknown"`.
  - Renders the crown/trophy marker on every row where `rank === 1`, including
    when two rows are tied for rank 1, and on no other row.
  - Renders `tasksPassed/totalTasks` and the formatted cost for a row, with
    the cost positioned as a secondary element under the primary tasks-solved
    text (assert both values present and their structural nesting).
  - Applies the highlight style to the row matching `currentGithubLogin` when
    provided, and to no row when `currentGithubLogin` is `undefined` or
    matches none of the rendered rows.
  - Preserves "Tied for #N" label text for a tied row (regression case,
    existing behavior).
  - `ranked: []` still renders the page's existing "No entries yet — beat the
    baseline." empty state unchanged (regression case in `page.test.tsx`).
- **Verification:** New and updated test files green; `pnpm typecheck` passes;
  visual check in a real browser that the row layout matches the described
  shape.

### U2. Add the click-to-peek modal

- **Goal:** Wire each row's click (and Enter/Space when focused) to open a
  modal with the entry's stat details and a link into the full run page,
  replacing the row's previous direct navigation.
- **Requirements:** R2, R4.
- **Dependencies:** U1.
- **Files:** `app/competition/CompetitionLeaderboardTable.tsx`.
- **Approach:**
  1. Add `useState` tracking which row (if any) is open, following
     `app/runs/[id]/CompletePromptModal.tsx`'s exact interaction shape:
     `role="dialog"`, `aria-modal="true"`, an `Escape`-key listener that
     closes it, a backdrop `onClick` that closes it with `stopPropagation` on
     the inner panel so clicking the panel itself doesn't close it, and a
     visible close button. Beyond that reused shape, add: on open, move focus
     to the dialog's close button (the reference modal skips this because its
     trigger is a native `<button>` that keeps focus on its own; this modal's
     trigger is a non-native row, so focus needs an explicit push); on close,
     return focus to the row that opened it. A full Tab focus-trap is *not*
     required — matches the reference modal's own scope, which also has none.
  2. Make each row clickable and keyboard-operable per the KTD above:
     `tabIndex={0}`, `onClick`, and `onKeyDown` treating Enter and Space the
     same as a click (with `preventDefault()` on the Space branch) — no
     `role="button"` override, and the row is no longer wrapped in a
     `<Link>`/`<a>` for its primary action.
  3. Modal content: a heading naming the entrant (e.g. the `githubLogin`,
     wired via `aria-labelledby` so the dialog has an accessible name distinct
     per row — the reference modal's static `aria-label` doesn't fit here
     since content differs per row), rank (with "Tied for #N" label when
     applicable), avatar + login, tasks passed/total, cost, submitted date
     (full, not just the truncated table format), and a "View full run" link
     to `/runs/${runId}` (reuses the existing route, unchanged).
- **Execution note:** No unit test exercises the actual open/close interaction
  — this repo has no test-utility for simulating client-side events
  (`CompletePromptModal.tsx`, the pattern this unit follows, has no test file
  either), so `renderToStaticMarkup`-based tests can only assert the row's
  initial closed-state markup. Verify the click/keyboard/Escape/backdrop
  behavior and the "View full run" link target in a real browser during
  manual QA instead.
- **Patterns to follow:** `app/runs/[id]/CompletePromptModal.tsx` in full —
  reuse its exact modal shell styling and keyboard/backdrop handling rather
  than inventing a new one.
- **Test scenarios:**
  - Initial (closed) SSR markup for a row contains the row's clickable
    affordance (`tabIndex="0"`, an attached click handler) but no
    `role="dialog"` element anywhere on the page before any interaction.
  - Test expectation beyond the above: none — see Execution note; interaction
    behavior (opens on click/Enter/Space, closes on Escape/backdrop click,
    "View full run" href equals `/runs/${row.runId}`) is verified by manual
    browser QA, not a unit test.
- **Verification:** Test file green; `pnpm typecheck` passes; manual browser
  QA confirms a row opens the modal on click and on Enter/Space when focused
  (Space does not also scroll the page), focus lands on the modal's close
  button on open and returns to the triggering row on close, Escape and
  backdrop-click close it, and "View full run" navigates to the correct
  `/runs/[id]`.

---

## Scope Boundaries

**Out of scope**

- The baseline card (`BaselineSection` in `app/competition/page.tsx`) — no
  submitting user, not part of `board.ranked`, unmentioned in the approved
  proposal.
- `SubmitCompetitionForm.tsx` and the submission flow.
- The main arena leaderboard (`app/page.tsx`) and its own row layout.
- Any change to `lib/competition-leaderboard.ts`'s `CompetitionRow` shape —
  the avatar is derived client-side from the existing `githubLogin` field, so
  no new field is needed.

---

## Assumptions

- This plan was written directly from the user's own detailed, already-approved
  proposal (composed in the same conversation from Mobbin + mlx.fast research)
  rather than a separate requirements document, so the usual pre-write scoping
  confirmation was skipped — the proposal's own wording is the settled scope
  and is cited above via `session-settled: user-approved` annotations.
- GitHub avatar URLs (`github.com/<login>.png`) are treated as a stable public
  convention needing no API key or extra request. A 404 (renamed/deleted
  account) is handled via the `onError` fallback in the KTDs above rather than
  left to render broken, since that failure mode turned out to be reachable
  in practice, not just theoretical.

---

## Sources & Research

- Row layout, avatar+badge placement, and the click-row-to-open-modal-with-stat-cards
  pattern: `https://mlx.fast/` leaderboard, reviewed live in-browser earlier
  this session.
- Current-user-row-highlighting pattern: Duolingo and Brilliant leaderboard
  screens, found via Mobbin (`mcp__mobbin__search_screens`) earlier this
  session.
- Existing modal interaction pattern reused verbatim:
  `app/runs/[id]/CompletePromptModal.tsx`.
