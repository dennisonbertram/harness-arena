# STORY-014: Navigating between /voice and /voice/results

**Result: PASS** (with 2 discoverability findings, both pre-documented as edge cases in the story spec)

## Flow Log

| # | Action | Result |
|---|--------|--------|
| 1 | On /voice/results, inspect for a link back to /voice | Only the header nav "Voice" link exists; no dedicated in-content back-link |
| 2 | Click header nav "Voice" link from /voice/results | Navigated to `http://localhost:3100/voice` correctly |
| 3 | Compare header nav on /voice vs. /voice/results | Identical order and styling: Harness Arena · Leaderboard · How it works · Submit · Voice |

## Navigation verification

- Header nav order/styling is consistent across both pages — same 5 links, same position, same visual weight (confirmed via screenshot comparison, step-1 vs step-2).
- No `aria-current` or active-state styling on any nav link on either page (checked via `getAttribute('aria-current')` and `className` on all nav `<a>` elements — all empty). This is a site-wide pattern predating the Voice feature, not specific to these two pages, so not filed as a Voice-scoped finding.
- No "Results" entry anywhere in the header nav — confirmed by listing all nav links' `href`s: `/`, `/`, `/how-it-works`, `/submit`, `/voice`. No `/voice/results`.
- "Voice" nav link correctly resolves to `/voice` from any page, including from `/voice/results` itself.

## Findings

2 findings — see `findings.json`:
- **F-014-1 (medium)**: No nav entry for results; the only discoverable path is the post-session "View results →" link, matching the story's documented gap for a researcher who won't sit through a session.
- **F-014-2 (low)**: No dedicated back-link from /voice/results to /voice (header nav covers it, but there's no in-content shortcut). Matches the story's documented "one-directional" edge case.

Both findings were anticipated by the story spec itself as known edge cases rather than surprises found during the walk — this walk confirms both are still present in the current build.
