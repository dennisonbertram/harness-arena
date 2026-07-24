# Topic: Researcher results + edge/error paths

Grounded in `app/voice/results/page.tsx`, `lib/voice-results.ts`, `app/voice/VoiceArena.tsx`, `lib/voice-flow.ts`, `app/api/voice/next/route.ts`, `app/api/voice/judgments/route.ts`. Fixture models: `model-alpha` / `model-beta`.

## STORY-008: Researcher reads a populated results table
**Type**: medium
**Topic**: Researcher results + edge/error paths
**Persona**: Researcher (anonymous, reaches `/voice/results` by URL — no login, no admin UI)
**Goal**: Understand which model wins more often for a pair and how to read the column semantics.
**Preconditions**: Fixture seeded; at least one judgment exists.
**Ideal path**: 3 — load `/voice/results`, read the row, read the footnote for the X/Y convention.
**Alternate paths**: none found — single read-only rendering path (no filters, sort, or pagination).

### Steps
1. Researcher opens `/voice/results` → h1 "Voice Arena results".
2. A table renders: **Pair | X wins | Y wins | Tie | Both bad | n**.
3. One row: `model-alpha vs model-beta` with counts and percentages, and n.
4. The footnote explains: pair names are alphabetical — X wins is the left model, Y the right.

### Variations
- After a re-seed orphaned judgments or unreadable blobs exist, a notice line appears above the table (only when non-zero).
- With 3+ models, one row per pair, alphabetical; zero-judgment pairs still render with n = 0.
- Page revalidates every 15s — a judgment submitted seconds ago may lag one window.

### Edge Cases
- Percentage cells round independently (`toFixed(0)`) so a row can sum to 99% — could be misread as a data bug.
- X/Y labels are display-order only, unrelated to the blinded A/B any evaluator saw.

## STORY-009: Results empty state — no judgments yet
**Type**: short
**Topic**: Researcher results + edge/error paths
**Persona**: Researcher checking in right after seeding.
**Goal**: Confirm the arena is live before anyone has voted.
**Preconditions**: Manifest seeded; zero judgments.
**Ideal path**: 2 — load the page, read the empty state.
**Alternate paths**: none found.

### Steps
1. Researcher opens `/voice/results` → h1 renders.
2. With zero judgments, the table is skipped; a bordered box reads: `No judgments yet.`

### Variations
- none found — single boolean branch.

### Edge Cases
- Distinct from the "not seeded" state (`Not seeded yet — run scripts/seed-voice.mjs to load prompts and responses.`) — different cause, similar plain-box treatment; skimmers could conflate them.
- Orphan/unreadable counts alongside zero valid judgments are not shown in this state.

## STORY-010: Audio clip fails to load — Retry vs Skip
**Type**: medium
**Topic**: Researcher results + edge/error paths
**Persona**: Evaluator mid-session; one clip's Blob URL fails.
**Goal**: Recover from a broken clip without losing the session.
**Preconditions**: A comparison is loaded; one clip errors.
**Ideal path**: 4 — error, Retry, clip loads, continue.
**Alternate paths**: Skip instead of Retry — abandons the comparison, no judgment.

### Steps
1. Response A's `<audio>` fires onError → inline `Couldn't load this clip.` with **Retry** and **Skip**.
2. **Retry** reloads the same src and clears the error banner optimistically.
3. On success, play and vote normally.
4. On repeat failure, the banner reappears — Retry is unlimited.

### Variations
- **Skip**: appends the comparison ID to the session exclude list (capped 25), no judgment recorded, next comparison fetches.

### Edge Cases
- `audioError` holds a single clip key: if Prompt errors, then Response A errors, only A's banner shows — the prompt's error is displaced.
- Skip discards any in-progress vote/reason/free text without confirmation.

## STORY-011: Skip-heavy session reaches "Session complete" (not the thank-you)
**Type**: medium
**Topic**: Researcher results + edge/error paths
**Persona**: Evaluator bailing on everything (bad clips, disinterest).
**Goal**: Exhaust the pool without voting; get an honest done state.
**Preconditions**: 5 comparisons available; 0 judgments.
**Ideal path**: 6 — skip all 5, land on the done screen.
**Alternate paths**: A mixed judged/skipped session reaches the same copy whenever judged < total.

### Steps
1. First comparison loads: "Comparison 1 of 5" / "0 of 5 judged".
2. Skip (after an audio error surfaces the button) → exclude list grows; refetch.
3. Repeat through all 5.
4. GET /next with all 5 excluded → done with judged 0 / total 5.
5. UI renders **"Session complete"**: "You judged 0 of 5 available comparisons — 5 were skipped or unavailable. Reload to revisit them."
6. "View results →" links to /voice/results.

### Variations
- Judged 3 / skipped 2 → same heading, scaled body copy.
- All judged → the different all-judged thank-you copy.

### Edge Cases
- "Reload to revisit" is literal: reload resets the session-local exclude list, so skipped comparisons return; judged ones stay excluded server-side.
- "Skipped or unavailable" cannot distinguish user skips from pool changes (e.g. mid-session re-seed).

## STORY-012: Submit fails on network error — Retry preserves the vote
**Type**: long
**Topic**: Researcher results + edge/error paths
**Persona**: Evaluator whose connection drops at submit time.
**Goal**: Land the judgment without re-entering outcome/reason/free text.
**Preconditions**: In the diagnostic step, outcome + reason selected.
**Ideal path**: 5 — submit fails, error shows, Retry, resend succeeds, next loads.
**Alternate paths**: A 4xx/429 rejection takes a different branch — auto-discard + refetch, no Retry.

### Steps
1. Submit → "Submitting…", controls disable; the payload is frozen.
2. fetch throws (offline) → red text `Could not reach the server. Try again.` + **Retry** button; outcome, reason, and free text remain selected.
3. Connectivity returns; **Retry** resends the identical frozen payload.
4. Server responds stored → next comparison loads.

### Variations
- 400 (stale IDs after re-seed), 401 (lost cookie), 429 (rate limit) → vote discarded, notice shown on the next pending screen, auto-refetch; no Retry offered (only status ≥ 500 is retryable).
- A genuine 500 (storage write failed) → same Retry-preserves-vote path.

### Edge Cases
- On the rejected path the comparison is NOT added to the exclude list — it can legitimately resurface later.
- 429 lands in the vote-discarding bucket even though it's the most "try again later" of the 4xxs (accepted: legitimate sessions stay far under 120/hr).

## STORY-013: Evaluator returns later — cookie persists, no re-serving
**Type**: medium
**Topic**: Researcher results + edge/error paths
**Persona**: Returning evaluator, same browser.
**Goal**: Resume without re-judging.
**Preconditions**: Judged 3 of 5 previously; `voice_evaluator` cookie (httpOnly, ~1yr) intact.
**Ideal path**: 4 — reopen /voice, cookie reused, judged filtered server-side, resume.
**Alternate paths**: Cookie missing (cleared/other device) → fresh identity; prior judgments unlinked.

### Steps
1. Reopen /voice (session exclude list resets — it never survives reload) → GET /next with the existing cookie.
2. Server validates the UUID, reuses the identity, lists judged keys, filters to the current manifest.
3. pickNext subtracts judged comparisons — already-voted pairs are never re-served.
4. First screen shows "Comparison 1 of 5" alongside "3 of 5 judged" — the count continues, not restarts.

### Variations
- All 5 already judged → thank-you screen renders immediately.

### Edge Cases
- Cleared cookie → new identity minted (subject to 30/hr/IP mint cap); old judgments orphaned from the person (accepted anonymous-design limit).
- Re-seed with new IDs between visits → judged filter drops old keys; evaluator starts at 0 against the new manifest.

## STORY-014: Navigating between /voice and /voice/results
**Type**: short
**Topic**: Researcher results + edge/error paths
**Persona**: Researcher or evaluator exploring.
**Goal**: Reach the arena from the nav, and results from the arena.
**Preconditions**: Fixture seeded.
**Ideal path**: 3 — nav "Voice", finish/skip a session, "View results →".
**Alternate paths**: Type `/voice/results` directly — bypasses the arena entirely.

### Steps
1. Click **Voice** in the header (Leaderboard | How it works | Submit | Voice) → /voice.
2. There is no "Results" entry in the nav — the only discoverable in-app path to results is the done-state link.
3. Reach a done state → click **"View results →"** → /voice/results.

### Variations
- Direct URL any time; the results page has no dependency on evaluator session state.

### Edge Cases
- Redundancy/discoverability: results reachable only via done-link or known URL; a researcher who won't sit through a session has no discoverable path.
- One-directional: /voice/results has no link back to /voice.
- Progress triple display on /voice: batch heading, cumulative counter, and the aria-live announcement restate close variants of one number.
