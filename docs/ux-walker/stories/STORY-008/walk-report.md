# STORY-008: Researcher reads a populated results table

**Result: PASS**

## Flow Log

| # | Action | Result |
|---|--------|--------|
| 1 | Click "View results →" from the done state | Navigated to /voice/results |
| 2 | Read the table | h1 "Voice Arena results"; table with columns PAIR, X WINS, Y WINS, TIE, BOTH BAD, N |
| 3 | Read the footnote | `"X vs Y" pair names are alphabetical — X wins is the left model, Y wins is the right.` |

3 steps, matches the story's ideal path exactly (load, read row, read footnote).

## Data verification

Single row: `model-alpha vs model-beta` — `3 (50%)` X wins, `2 (33%)` Y wins, `0 (0%)` Tie, `1 (17%)` Both bad, `n = 6`.

- Counts sum to n: 3+2+0+1 = 6. Correct.
- Percentages sum to 100% here (50+33+0+17=100) — did not hit the documented independent-rounding edge case (a row summing to 99%), but the format `N (P%)` matches spec exactly for every cell.
- n=6 ≥ the expected 6 (5 judgments from this session's STORY-001+005 walk + at least 1 pre-existing from the seeded evaluator cookie) — consistent with the judgments actually made in this session.

## Screen (step-1-results-table.png)

LOOK: single table, right-aligned numeric columns, uppercase column headers matching the site's existing label style (PROMPT, RESPONSE A on /voice), footnote in muted small text directly below the table — good hierarchy, no competing elements, one clear purpose. No borders/dividers beyond header and row rules — consistent minimal styling with the rest of the app.

MEASURE (geometry-audit.js): `pageOverflowX: 0`, no spills, no wrapped controls. Only the recurring nav-link width false positive (different label lengths, not a defect).

## Console / Errors

`agent-browser errors` — none.

## Findings

0 findings. Table renders correctly, matches spec, no visual or data defects found. (Note: the lack of a link back to /voice from this page is covered under STORY-014, not duplicated here.)
