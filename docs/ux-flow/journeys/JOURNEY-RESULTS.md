# JOURNEY-RESULTS — Researcher reading Voice Arena results

Sources: `docs/ux-paths/topics/researcher-and-edges.md` (STORY-008, STORY-009, STORY-014), walk reports + screenshots in `docs/ux-walker/stories/STORY-008/` and `STORY-014/`, current code in `app/voice/results/page.tsx`, `app/voice/page.tsx`, `lib/voice-results.ts`, `app/layout.tsx`.

Two fixes landed since the walker screenshots and are confirmed present in current code (read directly, not inferred): `/voice` has a "Just here for the numbers? View results" link under the intro paragraph (`app/voice/page.tsx:13-18`); `/voice/results` has a "← Back to the arena" link under the h1 (`app/voice/results/page.tsx:34-38`). Both scorecards below reflect the fixed state.

## Friction Scorecard

| Story | Ideal steps | Actual steps (current code) | Delta | Note |
|---|---|---|---|---|
| STORY-008 (read populated table) | 3 — load, read row, read footnote | 3 — identical, confirmed by walk report step log | 0 | Matches ideal exactly. |
| STORY-009 (empty state) | 2 — load, read empty box | 2 | 0 | Single boolean branch, no extra step observed in code. |
| STORY-014 (arena → results, researcher who won't sit through a session) | 3 — nav "Voice", finish/skip a session, "View results →" | **2** — nav "Voice", click "Just here for the numbers? View results" | **−1** | The new intro-link supersedes the documented ideal, which assumed no shortcut existed. A researcher no longer has to touch a single comparison. |
| STORY-014 (results → arena) | not separately specified | 1 — "← Back to the arena" link (equivalent to the pre-existing header "Voice" link, which was already 1 click) | 0 (raw steps) | Step count unchanged vs. header nav, but closes F-014-2 (no in-content back-link) — a recognition, not step-economy, win. |

Verdict driver: one direction is now *better than* its own documented ideal because the intro-link fix added a genuine shortcut past the forced-session assumption baked into the story. No direction regresses.

## Take-away Pass — `/voice/results` screen

Element by element, per heuristic #8 (take-away test):

| Element | Keep? | Reasoning |
|---|---|---|
| H1 "Voice Arena results" | Yes | Page identity. |
| "← Back to the arena" link | Yes | Closes a real documented gap (F-014-2); costs one line. |
| Orphan/unreadable notice (`app/voice/results/page.tsx:54-61`) | Yes, as-is | Conditional on `orphans > 0 \|\| unreadable > 0` — correctly absent on the common path, so it never taxes the normal read. Right call, no change proposed. |
| Table columns: Pair, X wins, Y wins, Tie, Both bad, n | Mixed | Pair, n, and the two win columns are load-bearing for the stated goal ("which model wins more often"). Tie and Both bad are load-bearing too, but for a secondary goal (understanding *inconclusive* judgments) — removing them wouldn't break the primary goal but would break the implicit "these four columns sum to n" honesty check, so keep. |
| Footnote (X/Y convention) | **No — see Simpler Version #1** | Exists only to decode a labeling choice the table itself made (X/Y instead of a self-evident order). It is a crutch, not information the researcher independently needs. |
| Percentages next to counts (`3 (50%)`) | Yes | Not redundant: n differs per pair row, so raw counts alone don't let a researcher compare relative preference strength across rows at a glance. Percentage earns its place once there's more than one pair with different n. |

Column semantics question, answered: **yes**, the footnote is a crutch for a poor labeling choice, not an unavoidable one. See below.

## The Simpler Version

Two concrete, scope-respecting diffs (no Bradley-Terry, no export, no filters — relabeling and reordering only):

**1. Replace the abstract X/Y column headers with self-evident ones; delete the footnote.**

Today, the Pair cell reads `model-alpha vs model-beta` (left-to-right, alphabetical) and the two win columns are labeled `X wins` / `Y wins` — an arbitrary letter mapping that only means "first name in the pair" / "second name in the pair" because a footnote says so. Every row read requires: read the pair name, recall the footnote's rule, then map it onto the columns.

Diff (`app/voice/results/page.tsx`):
```diff
- <th ...>X wins</th>
- <th ...>Y wins</th>
+ <th ...>Left wins</th>
+ <th ...>Right wins</th>
  ...
- <p ...>&quot;X vs Y&quot; pair names are alphabetical — X wins is the left model, Y wins is the right.</p>
+ (removed)
```
"Left"/"Right" (or "1st"/"2nd") match the Pair cell's own reading order directly — no letter alias, no decoder needed. This removes one element (the footnote) and one inference step per row, for every row, on every visit.

**2. Move `n` to the second column, right after Pair.**

Today `n` is last, so a researcher reads every percentage before learning how much data backs them (a pair with n=1 and a pair with n=40 currently look equally authoritative until the eye reaches the far-right cell). Putting `n` right after Pair means sample size is known before any percentage is read.

Diff: reorder `<th>`/`<td>` sequence from `Pair | X wins | Y wins | Tie | Both bad | n` to `Pair | n | Left wins | Right wins | Tie | Both bad`. Pure reorder, no new markup.

**No simplification found** for: the orphan/unreadable notice's conditional display (already minimal); the Tie/Both bad columns (both are load-bearing, not decoration); the percentage-plus-count format (not redundant given varying n per row).

## Clarity Issues

1. **"X wins"/"Y wins" jargon** — confirmed problem, same finding as Simpler Version #1. The labels are not self-explanatory; the footnote is required reading, not optional context.
2. **"Both bad" column label** — plain English, not jargon. No fix needed.
3. **"n" label** — appropriate for the stated persona (Researcher, statistically literate audience per the story's own framing). No fix needed; this is not the same audience the empty-state copy addresses.
4. **Empty-state vs. not-seeded-state distinguishability** — the story doc (STORY-009 edge case) asserts "similar plain-box treatment." **Checked against current code and this is not accurate**: `app/voice/results/page.tsx` renders the not-seeded message as a plain `<p>` with no border (lines 14-24), while the no-judgments message is a distinct bordered card (lines 40-51, `border` + `borderRadius: 12` + `padding: 32` + centered text). The copy also differs materially — the not-seeded message names the seed script explicitly (`scripts/seed-voice.mjs`), the no-judgments message doesn't. Measured, not inferred: these two states are visually and textually distinct in the current build. POC-materiality: **low** — the pre-documented conflation risk does not hold up against the actual markup; no fix needed.

## Summary

Friction is minimal to negative (better than the documented ideal) across all three stories once the two landed fixes are accounted for: STORY-008 matches its 3-step ideal exactly, STORY-009 matches its 2-step ideal, and STORY-014's arena→results direction now takes 2 steps against a 3-step ideal because the new "View results" shortcut on `/voice` lets a researcher skip the forced session entirely. The one real clarity issue — the X/Y column headers needing a footnote to decode — is fixable with a pure relabel (X→Left, Y→Right) that deletes the footnote outright; a second cheap diff (move `n` next to Pair) lets readers judge sample size before percentages. The pre-documented empty-state/not-seeded-state conflation risk does not hold up against the current code, which renders them with different boxing and different copy.

**Friction verdict: minimal.**
