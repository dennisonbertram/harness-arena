---
title: "feat: Voice Arena UI refresh — Mobbin-grounded comparison card, head-to-head results, prompts index, responsive nav"
type: feat
status: active
date: 2026-07-24
---

# feat: Voice Arena UI refresh — Mobbin-grounded comparison card, head-to-head results, prompts index, responsive nav

## Summary

Presentation-focused redesign of the Voice Arena screens grounded in three Mobbin references — Suno's audio A/B evaluation card, Uxcel's question-as-headline with peripheral progress, and Bleacher Report's head-to-head mirrored stat bars — plus two user-requested additions: a prompts index page showing the full pairwise comparison set, and the known 390px nav-wrap shell defect. No API, blinding, or reducer changes; the only new data surface is the read-only prompts index.

## Problem Frame

The shipped arena UI is functional but mechanically framed: the card leads with "Comparison 1 of 5" instead of the evaluation question, the three audio players read as an undifferentiated stack, the results page is a generic 6-column table, there is no way to see what prompt set is being tested, and the shared nav wraps "How it works" across three lines on phones.

---

## Requirements

- R1. The comparison card leads with the PRD's overall-preference question — "Which response would you rather get from a voice assistant?" — as the headline; batch/judged progress becomes peripheral: a thin progress bar (fill div over a low-contrast full-width track in `--gray-alpha-400`, so the bar reads as a bar even at 0%) plus one small combined counter line ("Comparison 3 of 10 · 7 of 24 judged").
- R2. Prompt and response clips render as stacked full-width rows (Suno pattern): a prompt row muted via text/label color only (`--gray-700`; the native `<audio>` element itself stays unstyled at full contrast), then two response rows of equal visual weight. After a vote, the picked response row gets a lightweight selected treatment (border/background keyed off the existing `outcome` state) so the pick reads on the listening surface; "Tie"/"Both bad" leave both rows unselected. "Play both" and played-counts stay, restyled to fit.
- R3. The vote row (A / B / Tie / Both bad) and diagnostic step keep their exact semantics and order. The free-text stays a `<textarea>` (compact single-line look, internal wrap/scroll for long entries — NOT an `<input>`, which would degrade 2000-char review), placeholder "Optional: what stood out?", no label row. Submit remains the sole primary action, visibly distinct when disabled, above the fold at 1280×800 with the diagnostic open — the stacked rows cost vertical space, so row heights/gaps are budgeted tight, and if the fold still misses, the intro copy above the card shrinks further (explicit fallback, not walker roulette).
- R4. /voice/results replaces the table with one head-to-head block per model pair (Bleacher Report pattern): header line with model names at opposite ends and "n = N" centered; win bars anchored at each OUTER edge growing INWARD toward a shared center line (widths = win rates; count+% labels at the outer edges); below, two compact rows "Tie N (P%)" and "Both bad N (P%)". Pairs with n = 0 render the header plus a single muted "No judgments yet" row instead of bars. On narrow viewports the bars scale down proportionally (never stack — stacking breaks the head-to-head metaphor). Orphan/unreadable notices, empty/not-seeded states, back-link, and the rounding footnote preserved.
- R5. New read-only index page `/voice/prompts` ("user request: show all the prompts / the pairwise set"): lists every prompt from the manifest — text, category, playable prompt audio — with a header naming the model pair under test and per-prompt judgment counts. Response clips are deliberately NOT listed (pre-listening labeled response audio would deblind individual clips; prompt audio is the shared input and safe). Linked from the /voice intro line and from /voice/results; states for not-seeded and empty manifest.
- R6. Header nav no longer wraps mid-phrase at 390px: nav link styles move from inline `style` props to a globals.css class (inline styles cannot be overridden by media queries — layout.tsx currently hardcodes `gap: 24, fontSize: 14` inline), links get `white-space: nowrap`, and a `@media (max-width: 480px)` rule tightens gap/font-size; if it still overflows at 360px the link group wraps as whole units below the brand (`flex-wrap` via the same class). No hamburger.
- R7. Behavior frozen: `lib/voice-flow.ts` untouched (27 tests pass unchanged); API payloads, blinding, error/skip/retry flows unchanged; the focus/aria-live MECHANISM is unchanged but its target element relocates with the heading — focus lands on the question headline and the aria-live text stays batch-relative and consistent with the visible counter (do not regress the earlier a11y parity fix). Files: `app/voice/page.tsx`, `app/voice/VoiceArena.tsx`, `app/voice/results/page.tsx`, `app/voice/prompts/page.tsx` (new), `app/layout.tsx`, `app/globals.css`, plus one pure counting helper in `lib/voice-results.ts`.

---

## Key Technical Decisions

- **Mobbin grounding**: Suno "Which version sounds better?" (stacked clip rows, inline optional text, grouped submit/skip; dark UI) — https://mobbin.com/screens/3c5c978d-738a-467d-9719-59af1b083a16; Uxcel comparison exercise (question headline, thin peripheral progress, confirm disabled until pick) — https://mobbin.com/screens/d3159a31-5959-41ba-ba4e-b23d5e7334ab; Bleacher Report head-to-head stats (outer-anchored mirrored bars, names at ends) — https://mobbin.com/screens/99629bea-cf1a-4170-a4a8-037b531bd774.
- **Existing design language only**: token custom properties, inline styles for one-offs, a globals.css class only where media queries demand it (nav) — native `<audio controls>` kept everywhere (custom players deferred; replay/error events must not change).
- **Intro copy shrinks as the question moves into the card**: the /voice intro paragraph currently previews the preference question; it trims to session mechanics (length, anonymity) plus the results/prompts links, since the card headline now owns the question — removes duplication and buys fold budget.
- **Prompts index reads the existing storage layer** (`getVoiceStorage().getManifest()` + `listAllJudgments()`), with a new pure `countJudgmentsByPrompt(judgments)` in `lib/voice-results.ts` — no new API routes; ISR revalidate 15 like the sibling pages.
- **Blinding boundary unchanged**: the index exposes prompt audio + model-pair names (already public on results) but never links response clips to model labels per-clip.

---

## Scope Boundaries

Out: custom audio players/waveforms, keyboard shortcuts, reducer/API changes, homepage/leaderboard restyling.

### Deferred to Follow-Up Work

- Waveform/scrubber players; Suno-style keyboard shortcuts.
- Per-prompt drill-down (transcripts, per-prompt win split) on the index — needs a deblinding policy decision first.

---

## Implementation Units

### U1. Comparison card redesign (/voice)

- **Goal:** Question-led, Suno-grounded comparison card.
- **Requirements:** R1, R2, R3, R7
- **Dependencies:** none
- **Files:** `app/voice/VoiceArena.tsx`, `app/voice/page.tsx`
- **Approach:** Reorder the card: progress track+fill; merged counter line; H2 question headline (carries the existing `headingRef`/tabIndex/focus logic and the aria-live div stays adjacent with its batch-relative text); muted prompt row; two response rows with conditional selected styling keyed off `outcome` ("a" → row A, "b" → row B, else none); Play both + played counts compact row; vote pills; diagnostic (buttons unchanged; textarea restyled compact, placeholder, no label row); Submit block unchanged semantically. Every dispatch/ref/handler preserved exactly — JSX structure and styles only. page.tsx: trim intro to mechanics + links ("Browse the prompt set" → /voice/prompts, keep the results link).
- **Patterns to follow:** existing token/inline-style conventions; Suno/Uxcel references.
- **Test scenarios:** Test expectation: none — presentation-only; `lib/voice-flow.test.ts` (27) must pass UNCHANGED; typecheck clean. Behavioral verification is the walker re-walk.
- **Verification:** walker: full loop intact (vote → selected-row highlight → diagnostic → submit → advance; focus/announcement present); Submit visible at 1280×800 with diagnostic open; coherent at 390×844.

### U2. Head-to-head results (/voice/results)

- **Goal:** Bleacher-Report-style pair blocks replacing the table.
- **Requirements:** R4, R7
- **Dependencies:** none
- **Files:** `app/voice/results/page.tsx`
- **Approach:** Per `VoicePairResult`: header (modelX left, "n = N" centered, modelY right); win bars anchored at outer edges growing inward (widths xWinRate/yWinRate of the half-width each, count+% at outer edges); compact Tie / Both bad rows; n=0 → muted "No judgments yet" row. View model untouched. All notices/states/footnote preserved. Bars scale at narrow widths (min font size on labels; no stacking).
- **Patterns to follow:** token colors; neutral emphasis (no per-model brand colors).
- **Test scenarios:** Test expectation: none — presentation-only; `lib/voice-results.test.ts` passes unchanged; typecheck clean.
- **Verification:** walker STORY-008: same numbers as the table rendered for the same data; readable at 390px; n=0 pair renders the empty row.

### U3. Responsive header nav

- **Goal:** No mid-phrase wrapping at phone widths, all pages.
- **Requirements:** R6, R7
- **Dependencies:** none
- **Files:** `app/globals.css`, `app/layout.tsx`
- **Approach:** Introduce `.site-nav` (and link-group) classes in globals.css carrying the current desktop values (gap 24, font-size 14, nowrap links, flex-wrap for the whole-unit fallback); layout.tsx swaps the inline `gap`/`fontSize` styles for the classes (inline styles beat media queries — the move is required, not optional); `@media (max-width: 480px)` tightens gap/font-size.
- **Test scenarios:** Test expectation: none — CSS/class-swap only.
- **Verification:** walker mobile check at 390×844 AND 360×640 on / and /voice: no mid-phrase breaks inside a link, no horizontal page scroll; desktop rendering unchanged at 1280+.

### U4. Prompts index page (/voice/prompts)

- **Goal:** The user-requested overview of the full pairwise comparison set.
- **Requirements:** R5, R7
- **Dependencies:** none
- **Files:** `app/voice/prompts/page.tsx` (new), `lib/voice-results.ts` (+`countJudgmentsByPrompt`), `lib/voice-results.test.ts`
- **Approach:** Server component, `revalidate = 15`: header "The prompt set" + one line naming the pair under test (from manifest models) and totals (N prompts, M judgments); list rows per prompt — category label (small caps, `.label`), prompt text, native audio player for the prompt clip, "K judgments" count from `countJudgmentsByPrompt`. Not-seeded and empty states mirror the results page's. Back-link to /voice. `countJudgmentsByPrompt(judgments)` → Map/record of prompt_id → count (pure, tiny).
- **Patterns to follow:** `app/voice/results/page.tsx` (states, tokens, revalidate), `.label` utility.
- **Test scenarios:** `countJudgmentsByPrompt`: judgments across 3 prompts → correct per-prompt counts; empty input → empty result; judgments with unknown prompt_id still counted under that id (page simply won't render unmatched ids).
- **Verification:** walker: /voice/prompts renders all 12 prompts with playable audio, categories, counts; links from /voice and /voice/results work; blinding held (no response audio, no per-clip model labels).

---

## Risks & Dependencies

- **Regression risk concentrates in U1's JSX restructure** — mitigated by the untouched reducer + tests, walker re-walk, unchanged API smoke.
- **A11y parity**: heading focus + aria-live move together; walker verifies both still fire (prior review fix — do not regress).
- **Fold budget at 1280×800** is now explicitly managed (R3 fallback) rather than discovered by the walker.
- The dev server on :3100 hot-reloads the shared checkout for walker verification.

## Sources & Research

- Mobbin references in KTDs (retrieved 2026-07-24, screens inspected directly).
- `docs/ux-flow/report.md`, `docs/ux-walker/latest-report.md` — prior findings to preserve (fold fix, plain results labels, aria parity) and fix (F-001-1 nav wrap).
- `app/layout.tsx:46-52` — inline nav styles necessitating the class migration (feasibility-verified).
- `lib/voice-results.ts` — `VoicePairResult` carries names/rates/counts/n; every manifest pair present with n=0 (design n=0 rule grounded in code).
