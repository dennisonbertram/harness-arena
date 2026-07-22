# Proof runs — v1 concept validation (2026-07-22)

Six real runs on production (https://harness-arena-psi.vercel.app), the vanilla
`pi` baseline plus five honest competitor system prompts, each scored on the
10 fixed Terminal-Bench 2.0 tasks with `zai/glm-5.2` via Vercel AI Gateway.
All numbers below are the platform's recorded results (from
`GET /api/leaderboard`), not estimates.

## Leaderboard (lexicographic: tasks passed desc, then total cost asc)

| Rank | Agent | Tasks passed | Total cost | Cost / task |
|------|-------|--------------|-----------|-------------|
| 1 | plan-then-execute | 3/10 | $0.1852 | $0.0185 |
| 2 | domain-savvy | 3/10 | $0.1876 | $0.0188 |
| 3 | cost-obsessed | 3/10 | $0.1887 | $0.0189 |
| 4 | terse-minimalist | 2/10 | $0.1803 | $0.0180 |
| 5 | pi-vanilla-baseline | 2/10 | $0.2020 | $0.0202 |
| 6 | thorough-explorer | 1/10 | $0.2175 | $0.0217 |

## What this shows

- **The concept works.** Holding harness, model, tasks, and container setup
  constant, the system prompt alone produced a differentiated leaderboard —
  from 1/10 to 3/10 tasks and from $0.18 to $0.22.
- **Efficiency-focused prompts beat the baseline on both axes.** All three
  3/10 solvers (plan-then-execute, domain-savvy, cost-obsessed) outscored the
  vanilla baseline (2/10) while costing less.
- **Verbosity is penalized as designed.** `thorough-explorer` — deliberately
  written to explore and re-read exhaustively — came last: fewest tasks
  passed and highest cost. The prompt is re-sent every turn, so its length
  and its extra turns both cost money.
- **Lexicographic ranking behaves.** The three 3/10 solvers are ordered by
  cost ($0.1852 < $0.1876 < $0.1887); terse-minimalist is cheapest overall
  ($0.1803) but ranks below them because it solved fewer tasks.

## Cost fidelity

Reported run costs track real AI Gateway spend closely (a representative run
reported $0.202 against $0.256 of measured gateway spend; the gap is the
missing-session cost floor of $0.05 applied to the ~2 tasks per run that hit
the 300s agent-timeout cap, where `pi` is killed before flushing its session
file). Total spend for all six proof runs plus development: **$2.96** of the
$25 POC budget.

## Known limitations (v1)

- Tasks that hit the agent-timeout cap have their cost approximated by a
  $0.05 floor rather than measured exactly (session file unflushed). The
  gateway credit ledger remains the authoritative spend ceiling.
- Sandbox network egress is currently open (`allow-all`) for the proof runs;
  a per-run domain allowlist is implemented and can be enabled via
  `RUNNER_NETWORK_MODE`. Full gateway-only lockdown is deferred (CONCEPT.md).
- Event-log and run-doc writes are best-effort under Vercel Blob's eventual
  consistency (per-event immutable blobs + resilient reads); a run's final
  results are authoritative, the live timeline is best-effort.

## How each run was produced

1. `POST /api/submissions {agent_name, prompt}` — validated, then screened by
   the LLM fraud judge (all six approved).
2. Approved → a Vercel Sandbox boots from the prebaked snapshot (Docker + the
   10 task images + a pinned `pi` runtime), runs `pi` with the submitted
   prompt as its entire system prompt against each task, then runs each task's
   official verifier from a clean copy.
3. Per-task pass/fail + cost stream back to the platform; the leaderboard
   updates. Prompts, per-task results, event timelines, and full `pi` session
   traces are public via the API and the web UI.
