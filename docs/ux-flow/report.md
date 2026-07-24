# UX Flow Critique — 2026-07-24 (Voice Arena, pre-PR)

## Run Summary
| Metric | Value |
|--------|-------|
| Journeys critiqued | 2 (evaluator session, researcher results) |
| Evidence source | walker artifacts (run of 2026-07-24) + current source |
| Verdicts | 2 minimal · 0 acceptable · 0 convoluted |

## Friction Scorecard
| Journey | Steps (actual/ideal) | Needless decisions | Re-entry | Dead ends | Verdict |
|---------|----------------------|--------------------|----------|-----------|---------|
| Evaluator: single judgment | 4/4 (minimal vote 3/3) | 0 | 0 | 0 | minimal |
| Evaluator: full session | matches ideal (16) | 0 | 0 | 0 | minimal |
| Researcher: read results | 2/3 (beats ideal via new intro shortcut) | 0 | 0 | 0 | minimal |

## Redundancy Map
- Duplicate paths: "Play both" vs individual players — deliberate PRD-mandated layering, keep. Three routes to results (intro shortcut, done-link, direct URL) — deliberate layering; the intro + done links co-render only on the done screen (see Accepted below).
- Duplicate information: progress triple display (batch heading / judged counter / aria-live) — aria-live mismatch FIXED (now announces the same batch-relative string as the visible heading); heading-vs-counter duplication is cosmetic at ≤10 comparisons and informative beyond.
- Overlapping features: "Tie" outcome vs "Not sure" reason, "Other" vs "Not sure" — different axes, acceptable for POC; revisit rubric wording if real evaluators conflate them. Note: `reason` is currently write-only (not read by results aggregation) — expected; it's research data for export/analysis, not display.

## Fixes Applied This Pass
1. aria-live announcement now matches the visible heading (accessibility divergence outside single-batch sessions) — `app/voice/VoiceArena.tsx`.
2. Disabled Submit now visually distinct (opacity + cursor) — previously identical to enabled with no `:disabled` rule anywhere.
3. Results table: "X wins"/"Y wins" → "Left wins"/"Right wins" (reading order of the Pair cell), `n` moved next to Pair, footnote decoder replaced with a rounding note — removes the letter-mapping decode entirely.

## Accepted (deliberate, documented)
- Dual "View results" links visible on the done screen (top intro shortcut + done-card CTA): each serves a different reading position; removing either reopens a walker finding (F-014-1) or degrades the done-state next action.
- "Played:" counter stays: honest signal that listens are tracked, plus replay feedback.
- Nav label "Voice" (not "Voice Arena"): matches the nav's short-label convention.

## Already Minimal
Both core journeys. Structural simplifications (auto-submit on reason pick, optional diagnostic) were considered and rejected — they conflict with the research design (diagnostic is required by the PRD's recommended POC approach).
