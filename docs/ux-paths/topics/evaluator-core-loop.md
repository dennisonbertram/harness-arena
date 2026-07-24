# Topic: Evaluator core loop

Stories cover the `/voice` evaluator flow end to end, grounded in `app/voice/page.tsx`, `app/voice/VoiceArena.tsx`, `lib/voice-flow.ts`, `lib/voice-session.ts`, and `app/api/voice/next/route.ts`. Fixture: 2 models, 5 prompts, 10 clips → exactly 5 comparisons total, all inside one batch of 5 (batch size = min(10, total)).

## STORY-001: First listen, "Play both", and a clean submit
**Type**: medium
**Topic**: Evaluator core loop
**Persona**: Priya, a research assistant asked to run some quick voice-model comparisons before a team meeting. Never used the tool before; wants to get into rhythm fast and do it "properly" — actually listen before judging.
**Goal**: Land on /voice for the first time and complete one full, honest comparison: hear both responses, vote, explain why, submit.
**Preconditions**: Fresh browser, no `voice_evaluator` cookie yet; Voice Arena is seeded (5 comparisons available).
**Ideal path**: 4 — Play both, one vote click, one reason click, Submit; the page load and diagnostic reveal are automatic, and free text is optional so a minimal user never touches it.
**Alternate paths**: Could listen via each clip's own play control (Response A then Response B) instead of "Play both" — same end state, just two separate play events tallied instead of one combined pass.

### Steps
1. Priya opens /voice → sees the "Voice Arena" heading, the intro paragraph, and the pending skeleton while VoiceArena fetches.
2. GET /api/voice/next resolves → skeleton is replaced by "Comparison 1 of 5" (heading receives focus, aria-live announces the comparison), "0 of 5 judged", the Prompt player with prompt text, Response A and Response B players, and the "Play both" button.
3. She clicks "Play both" → Response A starts; when A finishes, Response B auto-starts; play counts tick.
4. She decides B was better and clicks "B" → B selects; the diagnostic panel appears: "What most influenced your choice?" with 8 reason buttons and a disabled "Submit".
5. She clicks "More natural voice" → "Submit" becomes enabled.
6. She leaves "Anything else? (optional)" blank.
7. She clicks "Submit" → "Submitting…", controls disable.
8. POST succeeds → next comparison auto-fetches; skeleton briefly shows.
9. "Comparison 2 of 5" / "1 of 5 judged" loads; focus returns to the heading; play counts reset.

### Variations
- Plays the Prompt clip too before "Play both" — its counter increments independently.
- Votes "A" instead — identical flow.

### Edge Cases
- Progress is shown twice with different framing: batch-relative heading ("Comparison 1 of 5") and lifetime counter ("0 of 5 judged"). With this fixture's single batch they move in lockstep; nothing states they restate the same fact.
- "Submit" is visible but disabled the moment a vote is cast, until a reason is picked.

## STORY-002: Replaying Response A before committing to a vote
**Type**: short
**Topic**: Evaluator core loop
**Persona**: Marcus, a careful QA tester who doesn't trust his first impression and habitually re-listens before locking in a judgment.
**Goal**: Replay a clip he's unsure about, then vote with confidence.
**Preconditions**: Mid-session, on a loaded comparison; nothing played yet.
**Ideal path**: 5 — play A, replay A, vote, reason, Submit. The second listen is intrinsic to his goal, not removable friction.
**Alternate paths**: none found — re-hearing a clip means pressing its native play control again.

### Steps
1. Marcus plays Response A → play count "A 1".
2. He replays Response A → count increments to "A 2" (every play event counts).
3. He plays Response B once.
4. He clicks "A" → diagnostic panel opens.
5. He picks "Better answer" and clicks "Submit" → succeeds; next comparison loads.

### Variations
- Replays B, or both — same mechanics.

### Edge Cases
- Play counts have no cap and no first-listen/replay distinction.

## STORY-003: Switching a vote from A to B before submitting
**Type**: short
**Topic**: Evaluator core loop
**Persona**: Dana, an evaluator whose ear changes its mind mid-task.
**Goal**: Correct an initial vote before it's locked in.
**Preconditions**: Mid-session, on a loaded comparison; nothing voted yet.
**Ideal path**: 4 — vote A, vote B (correction), reason, Submit. Correction is a single extra click.
**Alternate paths**: none found — the vote buttons are the only mechanism; switching to Tie/Both bad behaves identically.

### Steps
1. Dana listens to both clips via "Play both".
2. She clicks "A" → selected, diagnostic panel opens.
3. She replays Response B and reconsiders.
4. She clicks "B" → B selects, A deselects; the diagnostic panel stays open.
5. She picks "Better pacing" and clicks "Submit" → succeeds. The submitted outcome is `b`; `time_to_judgment_ms` measures from her FIRST vote to submit (reducer keeps the first vote's timestamp).

### Variations
- Switches twice (A → Tie → B) — no limit.

### Edge Cases
- A previously picked reason persists across an outcome change — she could submit a "Better pronunciation" reason attached to a changed "Both bad" vote without re-checking.

## STORY-004: Adding a free-text note for a pronunciation nitpick
**Type**: medium
**Topic**: Evaluator core loop
**Persona**: Oskar, a linguistics grad student with precise opinions who wants his reasoning captured.
**Goal**: Vote, pick the closest reason, and add a specific free-text note.
**Preconditions**: Mid-session, on a loaded comparison with prompt text visible.
**Ideal path**: 5 — Play both, vote, reason, type note, Submit.
**Alternate paths**: Free text can be typed before or after the reason — independent fields, no ordering requirement.

### Steps
1. Oskar reads the prompt text under the Prompt player.
2. He clicks "Play both".
3. He notices Response A stresses a word wrong; clicks the better one → diagnostic opens.
4. He clicks "Better pronunciation" → "Submit" enables.
5. He types a note into "Anything else? (optional)" (well under 2000 chars).
6. He clicks "Submit" → payload carries `free_text`; next comparison loads.

### Variations
- Types near the 2000-char limit — the textarea stops accepting input at maxLength, no warning.
- Leaves free text blank — `free_text` omitted from the payload.

### Edge Cases
- Whitespace-only free text is trimmed and silently dropped from the payload.

## STORY-005: Finishing the entire fixture set and reaching the thank-you
**Type**: long
**Topic**: Evaluator core loop
**Persona**: Wendell, a part-time evaluator who wants to finish everything and get a clear done signal.
**Goal**: Judge all 5 fixture comparisons and reach the all-judged thank-you, then check results.
**Preconditions**: Fresh session (no prior judgments for this cookie); standard fixture seeded.
**Ideal path**: 16 — 5 × 3 minimum clicks (vote, reason, Submit) + 1 click on "View results →".
**Alternate paths**: Skipping instead of judging routes to the "Session complete" variant, not the thank-you — this goal requires judging all 5.

### Steps
1. Wendell opens /voice → "Comparison 1 of 5" / "0 of 5 judged".
2. Comparison 1: "Play both", votes "A", "Better answer", Submit.
3. "Comparison 2 of 5" / "1 of 5 judged" loads.
4. Comparison 2: plays A and B individually, votes "Tie", "More concise", Submit.
5. "Comparison 3 of 5" / "2 of 5 judged" loads.
6. Comparison 3: votes "B" without playing anything (allowed), "Not sure", Submit.
7. "Comparison 4 of 5" / "3 of 5 judged" loads.
8. Comparison 4: "Play both", votes "Both bad", "Other", one-line note, Submit.
9. "Comparison 5 of 5" / "4 of 5 judged" loads.
10. Comparison 5: "Play both", votes "A", "Better tone or emotion", Submit.
11. Auto-fetch returns done with judged 5 / total 5 → all-judged copy: "You've judged every available comparison — thank you."
12. He clicks "View results →" → /voice/results shows his judgments in the aggregate.

### Variations
- Reload mid-session → cookie persists; server excludes already-judged comparisons; resumes where he left off.
- One skip mixed in → "Session complete" copy with judged/skipped counts instead of the thank-you.

### Edge Cases
- With fixture total 5 (= one batch), batch position and overall count always restate each other; in a real 20-40 comparison session (batches of 10) they diverge and carry distinct information.
- The done variant is chosen purely by judged >= total; the copy is the only place a user learns whether they truly finished or ran out of un-skipped material.

## STORY-006: Voting on B without playing any audio
**Type**: short
**Topic**: Evaluator core loop
**Persona**: Grace, at a noisy coffee shop without headphones, curious whether the app requires listening.
**Goal**: Get through a comparison without pressing play on anything.
**Preconditions**: On a freshly loaded comparison, all play counts 0.
**Ideal path**: 3 — vote, reason, Submit (listening is deliberately not gated).
**Alternate paths**: none found — same path as every comparison, minus play clicks.

### Steps
1. Grace lands on the comparison and plays nothing.
2. She clicks "B" → selects immediately (no play-count gate), diagnostic opens.
3. She picks "Other" → "Submit" enables.
4. She clicks "Submit" → succeeds; stored `play_counts` are all zeros; no UI flag.

### Variations
- Picks "Not sure" instead — arguably more honest.

### Edge Cases
- No nudge or warning for zero-play judgments; only `play_counts` in the data reveals it (by design — R3 tracks, never gates).

## STORY-007: A tie, a "both bad", and two "Not sure" diagnostics
**Type**: medium
**Topic**: Evaluator core loop
**Persona**: Tomás, evaluating near-identical clips, then a clearly-bad pair.
**Goal**: Honestly register that neither response stands out, twice, without forcing a false preference.
**Preconditions**: Mid-session, on "Comparison 3 of 5".
**Ideal path**: 8 — per comparison: Play both, vote, reason, Submit ×2.
**Alternate paths**: Could vote Tie/Both bad without playing (STORY-006 path).

### Steps
1. Tomás plays both on Comparison 3; they sound nearly identical.
2. He clicks "Tie" → diagnostic opens.
3. No causal reason fits; he clicks "Not sure" (8th option) → "Submit" enables.
4. Submit → advances to Comparison 4.
5. He plays both; both sound clipped and low quality.
6. He clicks "Both bad" → diagnostic opens.
7. He clicks "Not sure" again.
8. Submit → advances to Comparison 5.

### Variations
- Uses "Other" + free text ("both clipped mid-word") for more signal.
- Ties but picks a substantive reason — any reason pairs with any outcome; nothing is enforced.

### Edge Cases
- "Not sure" has no visual distinction from the 7 substantive reasons — skimmers may pick it by position or miss it as the opt-out.
- "Both bad" surfaces no audio-quality-specific follow-up; the same 8 reasons serve every outcome.
