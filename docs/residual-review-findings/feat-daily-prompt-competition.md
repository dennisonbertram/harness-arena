# Residual Review Findings — feat/daily-prompt-competition

Run context: multi-lens code review (correctness, project-standards, testing, maintainability, security, performance, api-contract, reliability, adversarial) at head `7307e7f`. Items below were deliberately not applied — recorded here for traceability rather than fixed silently.

## Out of scope (would require touching the pre-existing main arena, explicitly excluded by the plan)

- **Rate limiter duplication**: `app/api/submissions/route.ts` still has its own inline per-IP limiter, structurally identical to the new `lib/rate-limit.ts`. Migrating it would touch the main-arena route the plan explicitly excludes from changes.
- **Judge/dispatch pipeline duplication**: same route also still runs its own inline judge→run→dispatch sequence, now a third copy alongside the two competition routes that share `lib/competition-dispatch.ts`. Same out-of-scope reasoning.
- **`MAX_BODY_BYTES` NaN bypass**: `Number.isFinite(NaN)` is `false`, so a request with a missing/malformed `content-length` header skips the 413 guard entirely. This is inherited verbatim from the pre-existing route's identical check; fixing it only in the new route would create behavioral inconsistency between the two without closing the gap in the (more heavily trafficked) original.
- **`clientIp()` trusts the first `X-Forwarded-For` hop**: a client can set an arbitrary XFF value to get a fresh rate-limit bucket per request. Inherited from the pre-existing route's identical `clientIp()`; the new `lib/rate-limit.ts` extracted the existing logic rather than fixing it, for the same consistency reason as above.

## Deferred as v2-scope hardening (real, but beyond "basic, not overbuilt" v1 dedup)

- **Self-induced-reap reroll**: a submitted prompt can deliberately go idle so its run is marked `reaped` (not judge-rejected), which the dedup/retry rules treat as "not the submitter's fault" — allowing indefinite resubmission of the identical prompt to re-roll the single noisy run. Closing this needs a way to distinguish genuine infra failure from a deliberately-stalled agent, which is a real design problem, not a quick fix.
- **Main-arena as a free variance preview**: the main arena's 5-run sample for a candidate prompt is publicly viewable and not coupled to the competition's dedup pool, so a competitor can pre-sample luck there before submitting the same prompt to `/competition`.
- **Dispatch starvation under shared concurrency cap**: main-arena traffic bursts can hold all of `lib/dispatch.ts`'s `MAX_CONCURRENT_RUNS` slots, delaying a competition entry with no distinguishing UI signal. Already an accepted tradeoff per the plan (shared cap, no separate budget).

## Minor/advisory (not applied — low value relative to effort, or matches existing project convention)

- No render-level test for `app/competition/SubmitCompetitionForm.tsx`'s 4-way outcome branching — matches the existing precedent (`app/submit/page.tsx` also has no test file).
- No dedicated test for `lib/rate-limit.ts`'s window-expiry behavior (only exercised indirectly through the route tests).
- `judgeAndDispatch`'s `after()`-success scheduling path is untestable from vitest (route handlers invoked directly always hit the synchronous fallback) — same limitation as the pre-existing main-arena route.
- `GET /api/competition/submissions` uses `submission_id` where the older `GET /api/submissions` uses `id` for the same concept — intentional within the new routes' own self-consistent contract, but diverges from the older sibling endpoint.
- Empty-array response from `GET /api/competition/submissions` can't distinguish "no submissions yet" from "all rejected" — a debug/inspection endpoint, not used by the `/competition` page itself.
