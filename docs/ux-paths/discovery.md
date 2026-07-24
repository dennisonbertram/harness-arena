# App Discovery: Harness Arena — Voice Arena (scoped)

Scope note: this discovery covers ONLY the new Voice Arena feature per the invocation focus. The wider app (leaderboard, submit, runs, tasks) is mapped elsewhere and excluded.

## Application Type
Web app (Next.js 16 App Router), dev server at http://localhost:3100. Seeded fixture data: 2 models ("model-alpha", "model-beta"), 5 prompts, 10 response clips → 5 comparisons per evaluator.

## Tech Stack
Next.js 16 (fork), React 19 client component for the arena loop, Vercel Blob storage, anonymous httpOnly `voice_evaluator` UUID cookie minted by the API.

## User Roles
- Evaluator (anonymous): listens and votes; identity = cookie; no login.
- Researcher (anyone with the URL for the POC): reads /voice/results; seeds via `node scripts/seed-voice.mjs` locally.

## Feature Map
### Evaluator arena (/voice)
- Intro copy (what you're judging, ~20-40 quick comparisons, anonymous)
- Pending placeholder while fetching next comparison
- Prompt player + Response A + Response B (`<audio controls>`, replay freely)
- "Play both" button (plays A then B sequentially; Safari-safe priming)
- Vote row: A / B / Tie / Both bad (changeable before submit)
- Diagnostic single-select (8 options) — required; optional free text (≤2000)
- Submit → advances; progress "N of M" per batch of 10 + overall judged/total
- Audio error → Retry (reload same clip) or Skip (no judgment, session-local exclude)
- Submit failure: network/5xx → inline error + Retry (same payload); 4xx → notice + auto-refetch
- Terminal states: all-judged thank-you (links to results); session-complete-with-skips copy; "not seeded" message
- Accessibility: aria-live announces new comparison; focus moves to comparison heading
### Researcher results (/voice/results)
- Table per canonical model pair: X wins / Y wins / Tie / Both bad (counts + %), n
- Orphan + unreadable counts shown only when non-zero
- Empty state (no judgments) and "not seeded" state
### Nav
- "Voice" link in the global header (Leaderboard / How it works / Submit / Voice)

## Navigation Structure
Header nav → /voice. Done state links → /voice/results. /voice/results is otherwise reached by URL or nav exploration.

## Data Entities
- Judgment (create via voting; read in aggregate on results)
- Comparison (served blinded by GET /api/voice/next)
- Manifest (seed-time; read-only at runtime)

## Integrations
- Vercel Blob (audio serving via public URLs; judgment blobs)

## Error/Empty States
- not_seeded (both pages), done (two variants), audio load failure, submit failure (retryable vs rejected), rate-limit 429 (mint cap 30/hr/IP; judgments 120/hr/IP)

## Recommended Story Topics
1. Evaluator core loop — first visit through several judgments to done (happy paths + variations)
2. Researcher results + edge/error paths — results reading, empty/error states, skip-heavy sessions, replay behaviors
