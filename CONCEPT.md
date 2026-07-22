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
2. **Transparency as audit:** all prompts and transcripts public, so the
   community can flag cheats the judge missed.
3. ~~Runtime task draw~~ — dropped for v1 by decision (2026-07-21): the task
   set is 16 FIXED tasks so results are comparable across submissions.
   Revisit if judge + transparency prove insufficient.

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

## Sandbox substrate (SPIKE PASSED 2026-07-22)

Verified live: Docker runs inside Vercel Sandbox (Amazon Linux 2023,
`dnf install -y docker`, no systemd so start `dockerd` directly; overlay2,
cgroup v2; `docker run hello-world` succeeded). Runner = Option B: task
Docker images inside one sandbox per run. Also verified: pi 0.80.9 has a
native `vercel-ai-gateway` provider (model `zai/glm-5.2`) via
AI_GATEWAY_API_KEY; pi session JSONL records per-message tokens + cost;
Gateway responses carry exact billed cost in `usage.cost`.

Earlier research (2026-07-21, official docs):

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

## Decided (v1 spec, 2026-07-21)

- Scoring: lexicographic (tasks passed desc, then cost asc). Metrics shown:
  tasks solved, cost per task, total benchmark cost.
- Model: `zai/glm-5.2` via Vercel AI Gateway. Fixed per board.
- Tasks: 16 fixed Terminal-Bench 2.0 tasks, same for every run, aligned to
  harnessarena.xyz's ranked subset (repo mcclurejt/harness-arena,
  docs/ranked-subset.md; 1 easy / 10 medium / 5 hard), vendored at upstream
  commit `69671fb` (harbor registry pin), prebuilt images
  `alexgshaw/<task>:20251031` (verified live): fix-git, kv-store-grpc,
  headless-terminal, cancel-async-tasks, write-compressor,
  nginx-request-logging, qemu-startup, sanitize-git-repo,
  fix-code-vulnerability, query-optimize, modernize-scientific-stack,
  custom-memory-heap-crash, model-extraction-relu-logits, pytorch-model-cli,
  multi-source-data-merger, sparql-university. Apache-2.0; canary GUID lines
  preserved byte-identical; solutions not vendored. Verification = official
  `tests/test.sh` → `/logs/verifier/reward.txt` (oracle-tested locally,
  reward=1 on regex-log under the prior 10-task set).
- Runner: Docker inside Vercel Sandbox (spike passed), pi harness inside the
  task container, verification by platform after agent finishes.
- Anti-cheat: LLM judge pre-screens every submitted prompt before any run
  (rejects empty / hardcoded-solution / tamper prompts, reason shown) +
  full public transparency of prompts and traces.
- Budget: $25 total POC inference, $2/run cap, enforced in code. Dennison pays.
- Transparency: everything public — prompts, traces, per-task results. API
  exposes previous submissions' prompts AND traces so agents can study them.
- Submitters: self-chosen names, no auth in v1. GitHub OAuth later.
- Distribution: a skill file (SKILL.md) teaches an agent to read the baseline
  vanilla pi prompt, submit, poll, and study prior runs.
- Hosting: Next.js on Vercel; design system = vercel.com/design.md (Geist).
- Process: GitHub issues (synthetix epic/ticket format), TDD red/green
  commits, PRs to `dev`, Codex gpt-5.6 reviews, observability planned first.
