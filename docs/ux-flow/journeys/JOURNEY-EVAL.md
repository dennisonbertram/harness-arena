# JOURNEY-EVAL — the evaluator session (Voice Arena)

Sources: `docs/ux-paths/topics/evaluator-core-loop.md` (STORY-001, STORY-005, STORY-006), walker screenshots and walk-reports for STORY-001 and STORY-005, current source (`app/voice/VoiceArena.tsx`, `app/voice/page.tsx`) as of commit `c4e46d8` ("fix(ux): results discoverability links + fit judgment flow above the fold").

## Friction Scorecard

| Story | Ideal path | Actual (walked) | Delta |
|---|---|---|---|
| STORY-001 (single judgment) | 4 (Play both → vote B → reason → Submit) | 4 — walk-report step-by-step table matches exactly, "no extra steps" | 0 |
| STORY-006 (minimal vote) | 3 (vote → reason → Submit, no playback) | 3 — demonstrated live in STORY-005's Comparison 3 ("Voted B without playing... reason Not sure, Submit") | 0 |
| STORY-005 (full 5-comparison session) | 16 (5×3 minimum + 1 "View results") | Not walked at the literal 3-click minimum for every comparison (the walker also exercised "Play both" on 3 of 5, which is voluntary listening, not imposed friction) — but every comparison closed in the minimum click sequence needed for its own outcome (vote, reason, Submit), and the terminal "View results →" click matched | 0 attributable to the UI |

- **Decisions per comparison**: outcome (4-way) and reason (8-way) are the two decisions the tool exists to collect — this is a research instrument, not a task to be sped through, so neither is a candidate for a default. Free text is already optional and untouched by 4 of 5 recorded comparisons. No decision economy issue found.
- **Re-entry**: none observed or possible — each comparison auto-loads with reset play counts and refocused heading (`step-3-advanced.png` vs `step-1-initial.png`); nothing carries state that must be re-entered.
- **Confirmations**: none exist in code or screenshots — Submit posts directly, no dialog.
- **Dead ends**: none. The done state (`step-3-done-state.png`) offers exactly one onward action, "View results →" — passes the dead-end audit.
- **Hesitation**: one is documented but already fixed. STORY-005's walk-report records the Submit button falling below the fold at 1280×800, causing two silent no-op clicks before the walker diagnosed it and started using `scrollintoview`. Commit `c4e46d8` (padding 24→18, tighter margins throughout the diagnostic panel) fixes this — confirmed in `fold-fix-verify-2.png`: at 1280×800, with the diagnostic panel fully open (vote cast, 8 reasons, textarea), Submit sits at y≈782, inside the 800px viewport. This is resolved, not a live finding.

**Verdict input**: 0 extra steps against every ideal path checked, one prior hesitation now fixed, no dead ends, no confirmations, no re-entry.

## Take-away Pass

**State 1 — loaded, unplayed** (`step-1-initial.png`, `step-3-advanced.png`): heading, batch/judged counters, Prompt player + quoted text, Response A/B players, "Play both", play-count line, 4 outcome buttons.
- Every element here is used by at least one story (prompt text read in STORY-004; individual players used as the STORY-001 alternate path; "Play both" is the STORY-001/005 main path; outcome buttons are the STORY-006 minimal path). Nothing fails the take-away test outright.
- One exception, carried to Clarity Issues below: the "Played: prompt 0 · A 0 · B 0" line. No story step in STORY-001/005/006 has the persona read or act on it — it is stated only from the narrator's/tester's point of view. Take-away test: remove it, does the user still succeed at every one of the three stories? Yes.
- **One primary action**: at this state there is deliberately no single dominant button — "Play both" and the four outcome buttons all use the same bordered/transparent `buttonStyle`/`secondaryButtonStyle` (confirmed in `VoiceArena.tsx`, no `primaryButtonStyle` in this state). Read against heuristic #9 that looks like a violation, but it is the correct choice here: the product's own design constraint is that voting is deliberately not gated on playback (STORY-006), so visually promoting "Play both" over the vote buttons would misrepresent listening as required. Equal weight is intentional and correct, not an oversight.

**State 2 — voted + diagnostic open** (`step-2-voted-b.png`, `fold-fix-verify-2.png`, `debug-state-3.png`): adds a divider, "WHAT MOST INFLUENCED YOUR CHOICE?" + 8 reason buttons, optional textarea, Submit.
- All required: reason selection is the second half of the research signal; the textarea is STORY-004's whole goal; Submit is the terminal action.
- **One primary action**: correctly satisfied — Submit is the only control using `primaryButtonStyle` (solid, high-contrast); the 8 reason buttons and the 4 outcome buttons stay in the neutral bordered style. Confirmed in every screenshot of this state.
- One gap, not visible in any screenshot but confirmed by reading the code: `primaryButtonStyle` is a fixed inline style object applied identically whether `disabled` is true or false, and `app/globals.css` has no `button:disabled` rule at all. Between "vote cast" and "reason picked," Submit is present but inert (per STORY-001's own documented edge case), and nothing in its styling communicates that — see Clarity Issues.

**State 3 — done** (`step-3-done-state.png`): one sentence, one link, inside the same card used throughout. Nothing to remove; walk-report calls it "clean, single message, single link, no distractions." No finding here.

**Batch heading vs. judged counter** (known, not re-litigated): at this fixture (batch size = total = 5) "Comparison X of 5" and "X of 5 judged" always move together, so it reads as the same fact stated twice. It isn't actually duplicate information — at production scale (batches of 10 inside a 20–40 comparison session, per the intro copy) they diverge and each carries something the other doesn't (where you are in this sitting vs. how much is left overall). For this POC's 5-comparison fixture it's a cosmetic near-duplicate, not a functional one; leaving it as documented low-severity is correct.

## The Simpler Version

Both measured ideal paths (STORY-001: 4, STORY-006: 3) are already matched exactly by the walked behavior, and the constraints given (diagnostic mandatory, playback ungated, blinding preserved) rule out the two moves that would normally shave a click:

1. Auto-submitting on reason-click (cutting Submit) was considered and rejected: STORY-004's alternate path types free text *after* picking a reason, so an auto-submit-on-reason would silently drop that path or require a debounce window that risks a premature submit on a research-data form. Not recommended.
2. Skipping the reason step for "obvious" outcomes was considered and rejected: the reason is one of the two things the whole tool exists to collect (see Decisions per comparison, above); defaulting it would corrupt the research signal, not just the UI.

So the loop itself does not simplify further. The one legitimate lever left is per-session friction across repeated reps (a real session is 20–40 comparisons), not per-comparison step count:

1. Land on `/voice` → comparison loads (unchanged).
2. Vote via keyboard (`A`/`B`/`T`/`N` or `1`–`4`) as well as click — not currently present in the code (no `onKeyDown` handler in `VoiceArena.tsx`), and not requested by any of the three stories, so this is a suggestion, not a finding.
3. Pick reason via keyboard (`1`–`8`) — same caveat.
4. `Enter`/`Space` submits once reason is set.

This would not change the click-count ideal paths already met; it would only lower the physical cost of the 5–8 reps a full session at production scale, and it's a "did the task ask for this" over-reach for a POC — noted here per the method's request to describe the simpler version, not recommended as a required fix.

**Conclusion**: no structural simplification found. The flow is already at its documented ideal-path minimum for every story checked.

## Clarity Issues

- **"Played: prompt 0 · A 0 · B 0"** — moderate-confidence finding. Present in every screenshot of the loaded state, never referenced by any of the three stories' steps as something the persona reads or acts on. STORY-006's own edge case describes `play_counts` as a backend signal ("only `play_counts` in the data reveals it... by design — R3 tracks, never gates"), which frames it as instrumentation, not a user-facing readout. There is a plausible counter-argument — it could double as reassurance that "Play both" actually fired both clips — but no story step exercises that use, so it isn't verified as providing user value. Worth reconsidering whether it belongs in the UI at all versus being silent telemetry; not urgent for a POC.
- **Disabled Submit has no visual disabled state** — code-verified, not directly screenshotted (the walker's own clicks moved through the "voted but no reason yet" state faster than a screenshot was taken). `primaryButtonStyle` in `app/voice/VoiceArena.tsx` is one fixed style object used for both the enabled and `disabled` button; `app/globals.css` has no `button:disabled` rule. Since the inline `background`/`color`/`cursor: pointer` are unconditional, a disabled Submit likely renders identically to an enabled one. This directly matches STORY-001's own documented edge case ("Submit is visible but disabled the moment a vote is cast, until a reason is picked") and is a real dead-click risk for the ~1-click gap between voting and picking a reason. Low severity (self-resolving in one more click) but easy to fix (e.g., reduced opacity when `disabled`).
- **"Tie" vs. "Both bad"** — clear. Standard paired-comparison vocabulary, sits directly beside A/B, no confusion evidenced in either walk-report.
- **"What most influenced your choice?"** — clear as placed (directly under the just-cast vote, inside the same card). The reason labels ("Better answer," "More natural voice," "Better tone or emotion," "Better pacing," "Better pronunciation," "More concise," "Other," "Not sure") read as a mix of content quality ("Better answer") and delivery quality (the rest) — consistent with the intro copy's "two anonymized voice-model responses" (model-generated, not just re-voiced identical text), so "Better answer" is meaningfully distinct from the delivery-focused reasons rather than redundant with them. No clarity issue found here.
- **"Just here for the numbers? View results"** (added in the fold-fix commit, visible in `fold-fix-verify.png`/`fold-fix-verify-2.png`) — clear, unambiguous escape hatch; not part of the three assigned stories but doesn't conflict with any of them.

## Summary

STORY-001 and STORY-006 both hit their documented ideal step counts exactly (4 and 3), with no dead ends, confirmations, or re-entry anywhere in the loop; the one real friction point on record — Submit falling below the fold at 1280×800 during STORY-005 — is already fixed and verified in the current screenshot. No structural simplification survives the flow's own constraints (mandatory diagnostic, ungated playback, blinding). Two small, low-severity clarity items remain open: the play-count line has no confirmed user-facing purpose, and the disabled Submit state is visually indistinguishable from enabled.

**Friction verdict: minimal**
