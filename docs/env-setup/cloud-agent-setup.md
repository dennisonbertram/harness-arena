# Cloud Agent environment setup

Development-environment setup log for Cursor Cloud agents. Standard commands
live in `package.json`; local run/gotchas are in
[../runbooks/local-init.md](../runbooks/local-init.md) and the
`## Cursor Cloud specific instructions` section of `AGENTS.md`.

## What was set up

- Toolchain already present on the VM: Node `v22.14.0` (satisfies
  `engines` `^20.19.0 || >=22.12.0`) and pnpm `10.33.4` (matches
  `packageManager`).
- Dependencies installed with `pnpm install --frozen-lockfile` (this is the
  startup update script).
- No external services required: local dev uses `STORAGE=file` on disk and
  `HARNESS_EXECUTION_MODE=deterministic-success` (no Sandbox, model, network,
  or hosted credentials).

## Verified commands

| Check | Command | Result |
| --- | --- | --- |
| Lint | `pnpm lint` | pass (1 pre-existing warning) |
| Typecheck | `pnpm typecheck` | pass |
| Tests | `pnpm test` | 1826 passed / 13 skipped |
| Build | `pnpm build` | pass |
| Run | `./scripts/init.sh --no-install` | dev server up on `127.0.0.1` |
| E2E smoke | `./scripts/init.sh --smoke --no-install` | 16/16 tasks passed, zero cost |

## Hello-world exercise

Submitted a system prompt through `POST /api/submissions` (agent
`hello-world-agent`). The fairness judge approved it, the run completed
deterministically with all 16 Terminal-Bench tasks passed at zero cost, and the
submission ranked #1 on `GET /api/leaderboard` and the `/benchmarks` page.

## Learnings / non-obvious gotchas

- `./scripts/init.sh` refuses to run on `main` or a detached HEAD; use `dev` or
  a `cursor/*` branch.
- The dev server binds `127.0.0.1` on a deterministic port hashed from the
  worktree path (range 20000–29999), not port 3000. Read the port/URL from the
  init JSON output or `.harness-arena/init.log`.
- The `/submit` UI page gates on GitHub OAuth, but `POST /api/submissions`
  works locally via the seeded development identity — that is how submissions
  are exercised without hosted credentials.
- `pnpm test` emits benign stderr (`cat: /does/not/exist`, `timeout: failed to
  run command '/usr/local/bin/pi'`) from failure-path fixtures; trust the vitest
  summary, not that noise.
