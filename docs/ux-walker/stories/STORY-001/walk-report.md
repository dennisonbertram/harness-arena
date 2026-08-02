# STORY-001: First listen, "Play both", and a clean submit

**Result: PASS**

Session note: the browser's `voice_evaluator` cookie had already judged 1 of 5 comparisons before this walk began (per task instructions). The walk landed on "Comparison 2 of 5" / "1 of 5 judged" rather than the fresh "Comparison 1 of 5" / "0 of 5 judged" the story describes — mechanics below are otherwise identical to the spec.

## Flow Log

| # | Action | Result | Matches spec? |
|---|--------|--------|----------------|
| 1 | Open /voice | Heading "Voice Arena", intro paragraph, then "Comparison 2 of 5" / "1 of 5 judged" loaded (no visible skeleton flash — resolved fast) | Yes, modulo starting index |
| 2 | Click "Play both" | Response A and B both completed (scrubbers at 1.5/1.5) within the ~4s wait; play counter read "Played: prompt 0 · A 1 · B 1" | Yes |
| 3 | Click "B" | B button highlighted (white fill); diagnostic panel appeared: "WHAT MOST INFLUENCED YOUR CHOICE?" with 8 reason buttons; Submit visible but disabled | Yes |
| 4 | Click "More natural voice" | Submit became enabled (no `[disabled]` attribute) | Yes |
| 5 | Leave free text blank, click Submit | Page advanced to "Comparison 3 of 5" / "2 of 5 judged"; play counts reset to 0; a fresh heading rendered | Yes |

Ideal path was 4 clicks (Play both, B, reason, Submit) — actual matched exactly, no extra steps.

## Screen-by-screen (LOOK + MEASURE)

**step-1-initial.png** — Comparison 2 of 5, unplayed. Card is well-centered, generous padding, one clear card boundary. Four vote buttons in a clean row. LOOK: no issues — single card, single obvious next action ("Play both"). MEASURE: `pageOverflowX: 0`, no spills.

**step-2-voted-b.png** — After play + vote. B button clearly highlighted (white vs. black), diagnostic section appears below a divider line, 8 reason buttons in a tidy 4×2 grid, Submit visibly greyed while disabled. LOOK: good hierarchy, no crowding, diagnostic clearly subordinate to the vote. MEASURE: `unevenRows` flagged the vote-button row (A/B/Tie/Both bad) and the top nav for width variance — both are text-content-driven width differences (expected for labels of different lengths), confirmed not a defect by direct box inspection. `wrappedControls` flagged all buttons as false positives — verified by direct `getComputedStyle` that `line-height: normal` breaks the script's wrap heuristic (button is 34px tall, single line, script's fallback threshold of 32.76px assumed against a mis-derived line-height). No real wrap in the screenshot.

**step-3-advanced.png** — Comparison 3 of 5, 2 of 5 judged, fresh unplayed state. Confirmed via `[aria-live="polite"]` div (a 1×1px clipped sr-only element reading "Comparison 3") that the advance is announced to assistive tech separately from the visible h2 "Comparison 3 of 5" — correctly hidden, not a visible duplicate.

**step-4-mobile.png** (390×844 spot-check) — Nav wraps badly: logo "Harness Arena" → 2 lines, "How it works" → 3 lines (see F-001-1). Main card content itself reflows fine — no card-level breakage. A visual footer clipping first suspected as a bug was traced (via `getComputedStyle`/fixed-position search) to the Next.js dev-tools portal overlay, a dev-mode-only floating element with its own stacking context — not a production defect, excluded from findings.

## Console / Errors

`agent-browser errors` — none. `agent-browser console` — only Next.js Fast Refresh / HMR / React DevTools informational logs, no warnings or errors.

## Findings

2 findings — see `findings.json`: 1 medium (mobile nav wrap), 1 low (progress-shown-twice, matches the story's documented edge case, flagged as low since it's benign at this fixture size).
