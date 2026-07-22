# Harness Arena — Concept

A leaderboard where the only variable is the system prompt. Submit one; the
platform runs it in the Pi harness inside a locked-down sandbox against a fixed
set of Terminal-Bench tasks with a fixed model, and ranks submissions by cost
to complete the tasks. Harnesses first; other harnesses/benchmarks later.

## Core loop

1. User submits a system prompt (likely authored by the user's own agent).
2. Platform spins up a sandbox (Vercel Sandbox), runs Pi with that prompt as
   the ENTIRE system prompt — there is no default prompt in the sandbox.
3. Pi works through a Terminal-Bench subset. Inference goes only through
   Vercel AI Gateway; the sandbox has no other network egress.
4. Platform runs each task's verification outside the agent's control, sums
   pass/fail and cost from AI Gateway usage data.
5. Leaderboard ranks the run.

## What's fixed vs. open

- Fixed: harness (Pi), model (one per leaderboard), task set size (S/M/L =
  task counts, TBD), sandbox limits, turn/budget caps.
- Open to competitors: the system prompt, and nothing else. It must describe
  the tools itself — published docs include Pi's tool list/schemas and the
  stock Pi system prompt as a reference starting point. Nothing hidden.

A nice property: cost scoring is self-penalizing for bloated prompts — the
system prompt is re-sent as input tokens every turn, so verbosity costs money.
No arbitrary "prompt quality" judging needed.

## Scoring (decided: lexicographic)

Rank by tasks passed (desc), then total cost (asc). Pure min-cost is
degenerate (a do-nothing prompt costs ~$0); cost-per-passed-task is gameable
by solving only the easiest task.

Display guidance (to avoid the "more tasks but higher cost looks worse"
confusion): leaderboard shows tasks-passed and cost as separate columns, and
any cost chart compares only runs with the same pass count (e.g. full
passers) so cost curves are like-for-like.

Attempts per submission: 1 to start; N-trial averaging is a later refinement
(run-to-run variance is real).

## Cheating / abuse vectors

Defense in depth — three cheap layers:

1. **LLM judge pre-screen (before spending inference money):** reads the
   submitted prompt against a published rubric; rejects empty prompts,
   task-specific hardcoded solutions, and instructions to tamper with
   verification. Rejection shows the reason. Judgment-based, so it can be
   fooled by obfuscation and can false-positive — it's a filter, not the
   guarantee.
2. **Runtime task draw (the structural guarantee):** subset drawn at run time
   from the pool; submitter doesn't know which tasks. Hardcoding then
   requires embedding solutions for the whole pool, which cost scoring taxes
   every turn. ~One line of code; keep it even with the judge.
3. **Transparency as audit:** all prompts and transcripts public, so the
   community can flag cheats the judge missed.

Plus platform-level controls:

- **Tampering with verification:** tests run by the platform after the agent
  finishes, from a clean copy (or checksummed) — the agent must not be able
  to edit them.
- **Runaway spend:** per-run budget cap, wall-clock cap, turn cap (values TBD).
- **Exfiltration:** egress locked to AI Gateway only.

## Architecture sketch

- Next.js app on Vercel: submission form, leaderboard, run detail (transcript
  + per-task cost breakdown).
- Runner: queue → one sandbox per task in parallel → set up task env → run Pi
  with submitted prompt + task instruction → platform runs the task's test
  script → record pass/fail + tokens/cost.
- Cost accounting: per-request usage from AI Gateway, tagged per run.
  (Verify the tagging mechanism — per-run attribution is load-bearing.)

## Sandbox substrate (researched 2026-07-21, official docs)

The Docker gap is smaller than first assumed:

- **Vercel Sandbox supports custom OCI images** via Vercel Container Registry:
  push the image to VCR, and `Sandbox.create({ image })` boots from its
  filesystem. Caveat: ENTRYPOINT/CMD are not executed — fine, since we drive
  everything via `runCommand`. (vercel.com/docs/sandbox/concepts/images)
- **Docker can run inside a Vercel Sandbox**: docs list "container runtimes
  like Docker" under system-privileged workloads. (vercel.com/docs/sandbox —
  feature-list level, not exercised yet)
- **Cloudflare** Containers/Sandbox bind images at `wrangler deploy` time; no
  documented runtime API for arbitrary images. Worse fit — not needed.
- **Escape hatch:** Terminal-Bench 2.0's harness (Harbor) natively supports
  remote backends — Daytona confirmed on tbench.ai (`--env daytona`); Modal,
  E2B, Runloop, GKE listed in Harbor docs (via a docs mirror; canonical page
  404'd — reconfirm if we go this route).

Runner options, in order of preference:

- **A (product architecture):** push each TB task image to VCR, boot one
  sandbox per task, run Pi inside, verify via `runCommand` from a clean copy.
  Validate with 2–3 tasks first — per-task images may need re-tagging/adapting.
- **B (zero adaptation):** one sandbox running dockerd inside, TB harness
  unmodified within it. Fallback if A's image adaptation is painful; sandbox
  resource limits unverified for this.
- **C (fastest to first result, off-stack):** Harbor + Daytona backend,
  inference still via AI Gateway. Escape hatch only.

## MVP cut

1. Pick one model (TBD) and a small set of TB tasks proven to run in Vercel
   Sandbox without Docker.
2. Runner: sandbox-per-task, Pi + submitted prompt, verify, sum cost.
3. Auth + submission + one leaderboard (one model × one size).
4. Rules/docs page: Pi tool schemas, stock Pi prompt, scoring rule, caps.

Deferred: multiple models/boards, other harnesses, other benchmarks (e.g.
SWE-bench), multi-trial averaging, hidden task sets.

## Decided

- Scoring: lexicographic (tasks passed desc, then cost asc).
- Transparency: everything public — prompts and transcripts. Copyable winning
  prompts are the point: take the leader and beat it.
- Who pays: Dennison, for the POC. Budget caps still required.
- Anti-cheat: LLM judge pre-screen + runtime task draw + public audit (see
  Cheating section).

## Open decisions

- Which model for the first board?
- Runner option A vs B (validate A with 2–3 tasks first).
