# UX Path Catalog: Voice Arena (scoped POC)

Generated: 2026-07-24
Total Stories: 14
Coverage: 20/20 discovered capabilities (100%) — scoped to the Voice Arena feature only

## Summary

| Type | Count |
|------|-------|
| Short | 5 |
| Medium | 7 |
| Long | 2 |

## Coverage Matrix

| Feature Area | Stories | Gaps |
|-------------|---------|------|
| First visit + core judgment loop | STORY-001, STORY-005 | none |
| Replay / Play both | STORY-001, STORY-002, STORY-007 | none |
| Vote change / diagnostic / free text | STORY-003, STORY-004, STORY-007 | none |
| Ungated voting (telemetry-only) | STORY-006 | none |
| Terminal states (thank-you / session-complete / not-seeded) | STORY-005, STORY-011, STORY-009 | not-seeded on /voice itself exercised only via API state — acceptable |
| Audio failure recovery (Retry / Skip) | STORY-010, STORY-011 | none |
| Submit failure (retryable vs rejected) | STORY-012 | none |
| Returning evaluator / cookie persistence | STORY-013 | none |
| Results table + empty states | STORY-008, STORY-009 | none |
| Navigation | STORY-014 | none |

## Story Dependency Graph

```text
STORY-001 (First visit, first judgment)
├── STORY-002..004, 006, 007 (independent single-comparison variants)
├── STORY-005 (Full session → thank-you)
│   └── STORY-008 (Results populated)
├── STORY-010 (Audio failure) ── STORY-011 (Skip-heavy → Session complete)
├── STORY-012 (Submit failure/retry)
└── STORY-013 (Return visit)
STORY-009 (Results empty) — requires seed but NO judgments (run before any voting)
STORY-014 (Navigation) — independent
```

## All Stories

See `topics/evaluator-core-loop.md` (STORY-001..007) and `topics/researcher-and-edges.md` (STORY-008..014).

## Redundancy Candidates

### Duplicate paths (same goal, multiple routes)
- Hearing both clips: "Play both" vs. individual play controls — intentional convenience layering (PRD-mandated auto-sequence), same end state.
- Reaching /voice/results: done-state link vs. direct URL — the direct URL is undiscoverable in-app; not a redundancy problem but a discoverability gap.

### Duplicate information (same fact, multiple surfaces)
- Progress: batch-relative heading ("Comparison 1 of 5"), cumulative counter ("0 of 5 judged"), and the aria-live announcement all restate near-identical numbers when total ≤ 10 (one batch). They diverge meaningfully only in 11+ comparison sessions.

### Overlapping features/tools
- "Not sure" reason vs. "Tie" outcome — different axes (diagnostic vs. verdict) but skimming users may treat them as interchangeable opt-outs.

## Gaps & Recommendations
- No in-nav path to /voice/results (evaluators get it via the done link; researchers must know the URL). Consider whether the POC wants results discoverable or semi-private.
- /voice/results has no link back to /voice.
- Percentage cells round independently and can sum to 99% (STORY-008) — cosmetic, worth a note or a rounding strategy if it confuses researchers.
- Reason persists across an outcome change (STORY-003) — possible stale diagnostic on changed votes.
- Single-slot audio error display (STORY-010) — two simultaneously broken clips show only the latest banner.
