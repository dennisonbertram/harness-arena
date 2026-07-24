# Voice Arena — Redundancy & IA Audit

Scope: `/voice` (evaluator flow) and `/voice/results` (researcher flow). POC framing — recommendations, not blockers, unless noted.

Evidence: `docs/ux-paths/catalog.md`, screenshots in `docs/ux-walker/stories/{STORY-001,STORY-005,STORY-008,STORY-014}/screenshots/`, and current source (`app/voice/page.tsx`, `app/voice/VoiceArena.tsx`, `app/voice/results/page.tsx`, `lib/voice-types.ts`, `lib/voice-results.ts`, `app/layout.tsx`, `app/page.tsx`) read directly for this audit.

---

## Duplicate Paths

**1. Two simultaneous "View results" links on the done screen — confirmed regression from the recent nav fix.**
`app/voice/page.tsx` unconditionally renders "Just here for the numbers? [View results](/voice/results)" above `<VoiceArena />` (lines 13–18), regardless of session phase. `VoiceArena.tsx`'s own done-phase render independently renders "View results →" (lines 200–202). Neither is conditioned on the other. Since the done-phase block renders *inside* the same page, once an evaluator finishes all comparisons the screen holds **two identical links to the same destination**, worded differently ("View results" vs "View results →"), stacked a few lines apart. This is evidenced by code, not just inference — I did not have a done-state screenshot taken *after* the intro-link fix landed to show it rendered, but the two render paths are unconditional and mutually independent in the current source, so they will co-occur. Recommend: suppress the intro-paragraph link once `phase === "done"` (or vice versa), keeping exactly one "View results" affordance per screen state.

**2. Play both vs. individual play controls — deliberate, not redundant.** Confirmed via `step-1-initial.png` / `step-2-voted-b.png`: "Play both" coexists with each clip's native player at all times. STORY-002 documents re-listening to a single clip as a distinct, legitimate need (careful re-checking before voting) that "Play both" can't serve. Different jobs, same UI real estate — clean.

**3. Reaching /voice/results — now 3 routes, but not drift.** (a) intro-paragraph link on `/voice` (new), (b) done-state link inside the arena panel, (c) direct/typed URL — still with no nav entry (`app/layout.tsx` nav: Leaderboard | How it works | Submit | Voice; no "Results"). (a) and (c) serve a researcher persona who never plays a session; (b) serves an evaluator who just finished. That split is legitimate. The unresolved gap — flagged already in `catalog.md`'s Gaps section — is that neither (a) nor (c) is discoverable from top-level nav; a researcher lands on `/voice`'s intro paragraph only if they click into "Voice" first and read past the description. Not a duplication problem; a discoverability one, addressed partly (not fully) by fix #1's intro link.

**Count: 3 items reviewed, 1 confirmed issue (duplicate CTA), 2 clean.**

---

## Duplicate Information

**1. Progress shown three ways — the known lead, and it's more than cosmetic.** `VoiceArena.tsx` renders three separate progress signals in the active-comparison view:
- Visible heading (line 235): `Comparison {comparison.progress.batch.position} of {comparison.progress.batch.size}` — batch-relative.
- Visible counter (line 238): `{comparison.progress.judged} of {comparison.progress.total} judged` — cumulative.
- Screen-reader-only `aria-live` div (lines 230–232): `` `Comparison ${comparison.progress.judged + 1}` `` — cumulative, not batch-relative.

With this fixture (5 comparisons = one batch), `batch.position` and `judged + 1` are numerically identical, so nothing looks wrong in the screenshots (`step-1-initial.png`, `fold-fix-verify-2.png`, `step-1-comparison4-both-bad.png` all show them in lockstep). But the heading text a sighted user reads and the text a screen-reader announces are pulled from **different fields** (`batch.position` vs `judged + 1`). STORY-005's own edge-case note confirms these diverge once real sessions span multiple 10-item batches — at that point a sighted user sees "Comparison 3 of 10" (second batch) while the SR-only announcement would say "Comparison 13" (cumulative), a real mismatch between the two channels, not just triple-stated redundancy. Additionally, the heading itself receives programmatic focus on every new comparison (`headingRef.current?.focus()`), which most screen readers already announce on its own — making the separate `aria-live` region likely redundant *in addition to* being inconsistently sourced. Recommend: drop the `aria-live` div (focus-move already announces the heading) or, if kept for redundancy against focus-management edge cases, source it from `batch.position`/`batch.size` to match what's displayed.

**2. Counts + percentages per results cell — reviewed, not a redundancy.** `step-1-results-table.png` shows cells like "3 (50%)". This is one fact shown one way (count, with a derived percentage for convenience) inside a single cell — not the same fact restated across separate surfaces. Already correctly filed by `catalog.md` as a rounding/cosmetic note (`toFixed(0)` on independent cells can sum to 99%), not a redundancy.

**Count: 2 items reviewed, 1 elevated to a real (not just cosmetic) issue, 1 confirmed clean.**

---

## Overlapping Features

**1. "Tie" (outcome) vs. "Not sure" (reason) — different axes, and the UI does little to signal that.** Confirmed via `step-1-comparison4-both-bad.png` / `step-2-comparison5-final.png` and the code: the outcome row (`A / B / Tie / Both bad`) and the reason row (8 buttons including `Not sure`) use the **exact same button styles** — `VoiceArena.tsx` lines 297 and 316 both resolve to the identical `selectedButtonStyle` / `buttonStyle` pair. The only differentiators are a thin divider and the label "WHAT MOST INFLUENCED YOUR CHOICE?" appearing above the reason row only — the outcome row has no header at all. A skimming evaluator (per the catalog's own persona framing) has no strong visual cue that these are two different questions on two different axes; identical chrome plus one unlabeled group makes it plausible someone picks "Tie" as a proxy for "I don't know" rather than "Not sure." Recommend (POC-level): give the outcome row its own small label ("WHAT'S YOUR VERDICT?" or similar) so both groups are equally headed, rather than only the second.

**2. "Other" vs. "Not sure" reasons — indistinguishable in practice today because reason data isn't surfaced anywhere yet.** Both sit adjacent in the same 8-button reason row with identical styling (no code path differentiates them). Picking "Other" doesn't gate or prompt the free-text field — `freeText` (lines 322–332) is unconditionally rendered and optional regardless of which reason is selected, so "Other" with blank free text and "Not sure" produce data that's equally uninformative. Checked `lib/voice-results.ts` directly: the results-aggregation logic never references `reason` at all — the results table (`app/voice/results/page.tsx`) aggregates only by **outcome** (X wins / Y wins / Tie / Both bad), never by reason. So right now the entire reason axis, "Other" and "Not sure" included, is write-only — captured in storage but not read back anywhere in the product. This doesn't make the axis pointless (it's presumably for later offline analysis), but it does mean the Other-vs-Not-sure distinction currently has no visible payoff for a researcher looking at `/voice/results` — worth knowing if it's shaping how the reason UI gets prioritized going forward.

**Count: 2 items reviewed, both genuine but graded "acceptable" for a POC — not confusing enough to block, worth a low-cost visual/labeling tweak.**

---

## Hierarchy & IA

**1. "Voice" nav label doesn't say what the page is, and doesn't match the page's own name.** `app/layout.tsx` nav: `Leaderboard | How it works | Submit | Voice`. The page itself self-identifies as "Voice Arena" (h1, confirmed in every `/voice` screenshot) and its results page as "Voice Arena results" (h1, `app/voice/results/page.tsx` line 31–33). The nav label drops "Arena" both times. For a first-time evaluator scanning the top nav, "Voice" alone doesn't signal "blind A/B comparison tool" — it reads more like an audio/settings label. Recommend: nav label "Voice Arena" (matches the h1 exactly, costs nothing, one word longer).

**2. Nav naming convention is inconsistent between the two arenas.** The main arena's nav item, "Leaderboard," names its **results sub-heading** (`app/page.tsx` line 128: `Leaderboard · ranked by pass rate`), not its own page h1 ("Harness Arena", line 65). The Voice arena's nav item, "Voice," names neither its own h1 ("Voice Arena") nor its results page h1 ("Voice Arena results"). So the two features pick their nav label from two different anchors (main arena → its output section; voice arena → neither), and the equivalent-purpose output page for Voice ("Voice Arena results") has no nav representation at all, unlike "Leaderboard" which effectively *is* the main arena's output surfaced at top level. This is the same asymmetry already named as an open question in `catalog.md`'s Gaps section ("Consider whether the POC wants results discoverable or semi-private") — flagging here because it's also a one-concept-one-name violation, not just a discoverability gap.

**3. Nothing found trivially elevated.** Reviewed low-hierarchy elements across all screenshots — the play-count line ("Played: prompt 0 · A 0 · B 0") and the footer runtime string are both small, muted, and correctly subordinate to the comparison card. No over-weighted decoration found.

**4. Terminology ("comparison" / "judgment") is consistent.** The internal code name for the outcome-submit action is `vote` (`dispatch({ type: "vote", ... })`), but this never leaks into user-facing copy — every visible surface says "comparison" (the pair) and "judged"/"judgment" (the act), including the done-state copy, the results h1, and the progress counter. Clean; no action needed.

**Count: 4 items reviewed, 2 naming/IA gaps flagged, 2 confirmed clean.**

---

## Summary

7 findings total: 1 confirmed duplicate-CTA regression (two "View results" links stacking on the done screen after the recent intro-link fix), 1 progress-announcement mismatch elevated from cosmetic to a real accessibility inconsistency (`aria-live` sources cumulative count while the visible heading sources batch-relative count — they'll diverge outside this single-batch fixture), and 2 acceptable-but-worth-a-tweak overlaps (Tie/Not sure and Other/Not sure share identical button styling with no axis cue, and the entire reason axis is currently write-only). The remaining 2 IA items are naming-consistency notes ("Voice" vs "Voice Arena"; nav-label convention differs between the two arenas), not urgent. "Play both" vs. individual controls, percentage-cell formatting, and terminology consistency were all reviewed and are clean.
