# The swe-bench board

The second benchmark board on Harness Arena. Where the default board runs
Terminal-Bench 2 tasks, the swe-bench board measures prompts on real open-source
bug fixing: each task is a **repo pinned at a base commit plus its issue text**.
The agent works inside a prebuilt container for that repo, and the platform
captures whatever patch it produced and verifies it independently.

Task specs live in `tasks-swe/<id>.json` (schema: `lib/swe-task.ts`
`SweTaskSchema`). The agent sees only `repo`, `base_commit`, and `issue_text`
(plus repo tooling); everything verification-related stays platform-side.

## Scoring

Same lexicographic rule as the terminal-bench board:

1. **FAIL_TO_PASS pass rate** — every test named in `fail_to_pass` must go
   red → green after the patch is applied.
2. **PASS_TO_PASS regression guard** — every test in `pass_to_pass` must stay
   green.
3. Then lowest inference cost.

A patch only scores when it applies cleanly to the base commit AND the
instance's `test_cmd` produces the required pass/fail pattern
(`lib/swe-task.ts#buildVerifyCommand`). Reward attribution comes from the
runner parsing FAIL_TO_PASS/PASS_TO_PASS out of the test output — the exit
code alone is not the score.

## Anti-cheat layers

1. **Judge pre-screen** (`lib/judge.ts`) — the fairness rubric rejects, among
   others:
   - hardcoded diffs/patches for the known task set (embedded `git apply`
     payloads, before/after file bodies keyed to a known instance);
   - instructions to edit test files or verification scripts;
   - instructions to game FAIL_TO_PASS detection (e.g. make the test command
     exit 0 unconditionally, stub the test runner);
   - prompt injection aimed at the verifier (forged pass reports smuggled into
     patch/commit messages).
   The judge still fails CLOSED: an unparsable verdict after one retry throws
   and routes the submission to `pending_review`, and every gateway call is
   bounded by a 30s `AbortSignal.timeout`.
2. **Structural guarantee: clean-copy verification** — the agent never runs
   the tests that decide its score. The platform captures the working-tree
   diff against `base_commit` as the submission's patch (`task.patch_captured`),
   then applies that patch to a **clean copy of the repo** the agent cannot
   touch and runs `test_cmd` there. Editing files in the agent's own workspace
   cannot alter verification; only the captured patch carries over.
3. **Public traces** — prompts, run events, patches, and per-task traces are
   public, so the community can audit exactly what any scored run did.

## How tasks are vendored

`scripts/vendor-swe-tasks.mjs` turns SWE-bench Verified instances into
`tasks-swe/<id>.json` specs:

- instances are pinned by `base_commit` from a checked-in manifest
  (`SWE_MANIFEST`) — a fetched commit mismatch aborts vendoring;
- **gold/test patches are NEVER vendored** — the script refuses input records
  carrying `gold_patch`/`test_patch`/`solution_patch`, so solutions stay
  upstream;
- the upstream **canary GUID** line is preserved byte-identical in every spec
  (`CANARY_GUID`) for provenance audits;
- output is staged and validated before replacing `tasks-swe/`.

Usage: `node scripts/vendor-swe-tasks.mjs [--fetch]`.

## Runner contract (`RUN_MODE=swe`)

Summary of what the runner does differently when `RUN_MODE=swe` (or the task
payload carries `benchmark: "swe-bench"`):

- tasks come from the vendored SWE specs (`buildRunnerTasks` in
  `lib/tasks-for-runner.ts`), carrying `repo`, `base_commit`, `workdir`,
  `install_cmd`, `test_cmd`, `fail_to_pass`, `pass_to_pass`;
- the agent runs in the instance's prebuilt Docker image
  (`ghcr.io/harness-arena/swe:<instance_id>`) with deps already installed —
  dependency installation is NOT part of the agent's budget;
- after the agent finishes, the platform captures the patch
  (`git diff` against `base_commit`), then verifies from a clean copy:
  `git apply --check && git apply && test_cmd`;
- per-task results carry `patch_blob_url` alongside the usual trace URL;
- the swe-bench board has its own per-run spend cap ($6/run — see
  `SWE_RUN_BUDGET_CAP_USD` in `lib/budget-caps.ts`, TUNABLE from Phase-0 spike
  data) instead of the terminal-bench $2/run cap.

## Launch ops checklist

1. **Vendor the instances**: `node scripts/vendor-swe-tasks.mjs --fetch`
   (or vendor from a local raw dir via `SWE_RAW_DIR`). Review the staged
   output, confirm no solution material and intact canaries, and commit
   `tasks-swe/`.
2. **Build and push the dep-preinstalled images**: one image per instance,
   tagged `ghcr.io/harness-arena/swe:<instance_id>` with repo dependencies
   installed at `base_commit`. These are referenced by `docker_image` in each
   vendored spec and baked into the runner snapshot's image pull set.
3. **Seed the competition**: `node scripts/seed-swe-benchmark.mjs --yes`
   creates the idempotent swe-bench Competition row (`benchmark: "swe-bench"`,
   model/provider overridable via `SWE_MODEL` / `SWE_GATEWAY_PROVIDER`; prize
   fields are deliberately left TBD).
4. Verify the board renders at `/benchmarks?benchmark=swe-bench` and that a
   smoke submission queues with `RUN_MODE=swe` dispatch and the $6 cap in the
   runner env (`BUDGET_CAP_USD=6`).
