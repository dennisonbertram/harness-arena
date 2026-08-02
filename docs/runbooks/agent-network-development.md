# Agent-network development and rollout runbook

## Current hard boundary

As of 2026-08-03 the project owner has prohibited production deployment and
production configuration/data mutation. Another agent is preparing a dedicated
development environment. This runbook stops at local verification until that
environment is handed over; production migration, feature flags, canary tests,
and rollout evidence are not authorized.

## Local red/green lanes

```sh
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm test

cd mcp
npm ci
npm test
npm pack --dry-run
```

For a feature, first commit the focused failing test and record why it failed.
Then implement, run that test, its adjacent integration suite, TypeScript, the
MCP build/package lane when affected, and finally the broad suite. PGlite is the
local SQL engine; a real development Postgres remains mandatory for locks,
multi-process races, permissions, migration, and connection-failure evidence.

Record the exact root-suite pass/fail/skip count and keep feature-targeted
integration evidence separate from the broad regression result.

## Development environment handoff contract

Before testing, obtain explicit non-production values for:

- a Neon/Postgres database and migration role/application role;
- an agent session issuer, audience, key id/signing material, cursor secret,
  and stable GitHub Device Flow callback/origin;
- a separate private artifact Blob store with read/write credentials;
- deterministic judge/runner provider endpoints owned by #144;
- the redacted event/log sink contract owned by #145;
- optionally a dedicated Privy non-production app only after the custody POC.

Never copy production tokens or data. Keep `HARNESS_ARENA_URL` pointed at the
approved development origin. Run migrations `0001` through `0011` forward and
confirm readiness returns every exact version before enabling any write path.

## Required development proofs

1. Built MCP stdio initialize/tools/resources; stdout contains only protocol.
2. Two-phase GitHub login survives process restart, cancellation, denial, and
   slow-down without exposing the device code.
3. Two concurrent exact entries across separate app processes produce one
   recovery lease, judge call, submission, run, audit, and replay; a changed-body
   key conflicts; lease loss fences checkpoints; `judge_started` ambiguity stays
   blocked for reconciliation.
4. Chat ban/leave immediately blocks join/read/write/subscribe across two app
   processes; reconnect from the last cursor loses no messages; quota and
   tombstone audit survive restart.
5. Private upload rejects wrong owner/key/type/size, expired/reused capability,
   public reads, checksum mismatch, decompression bomb, forbidden secret, and
   scanner timeout. Reconciliation repairs every injected cross-store crash.
6. External payout proof cannot replay across entrant/address/domain/chain and
   a profile change observes reauthentication/cooldown.
7. Privy remains disabled unless immutable GitHub-id linkage, user-owned wallet
   index `0`, browser recovery/export, private-key non-access, and signed,
   deduplicated/out-of-order webhook behavior all pass.
8. Eligibility freeze uses a complete reconciled result snapshot and approved
   trace/profile revisions; repeats are immutable; no transfer API exists.

Capture correlation id, operation id, expected/actual state, relevant safe log
event, and database/outbox counts for each proof. Do not include secrets or
participant content in transcripts.

## Rollback and later production gate

The future production procedure remains blocked. When separately authorized,
it must re-fetch the clean serving Git SHA with Vercel CLI, verify #140/#141,
apply only additive migrations, deploy flags off, inspect readiness/logs, and
enable results/chat/traces/address/Privy/eligibility one at a time. Application
rollback uses flags/deployment rollback; database rollback is forward-only.
No audit or payout record is deleted during rollback.
