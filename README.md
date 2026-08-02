# harness-arena

Next.js (App Router, TypeScript strict) scaffold for Harness Arena.

## Read-only operations API

Provision `OPS_READ_TOKEN` server-side, then use GET only: `curl -H "Authorization: Bearer $OPS_READ_TOKEN" "$HOST/api/ops/v1/inventory?kind=runs&limit=50"`. The versioned index, inventory, read, and summary routes live below `/api/ops/v1`; all are `no-store`, cursor-bounded, and redact URL query credentials. This is distinct from and never returns `BLOB_READ_WRITE_TOKEN`.

## Getting started

```bash
cp .env.example .env.local   # fill in real values locally, never commit
pnpm install
pnpm dev
```

## GitHub login setup

Submitting a prompt (main arena or competition) requires signing in with
GitHub. To run that locally or in production:

1. Create a GitHub OAuth App at github.com/settings/developers with callback
   URL `<origin>/api/auth/callback/github` — use **separate apps** for
   `http://localhost:3000` and your production domain; a single app can't
   have two callback origins in a way that works for both cleanly.
2. Generate a session secret: `npx auth secret` (or any random 32+ byte
   value) and set it as `AUTH_SECRET`.
3. Set `AUTH_GITHUB_ID`/`AUTH_GITHUB_SECRET` from the OAuth App's client
   ID/secret. Set all three vars (`AUTH_SECRET`, `AUTH_GITHUB_ID`,
   `AUTH_GITHUB_SECRET`) in every Vercel environment (Production, Preview,
   Development) you deploy to.
4. **Vercel preview deploys do not support sign-in** — each preview gets a
   unique `*.vercel.app` URL, and GitHub OAuth Apps only accept one fixed
   callback URL. Sign-in only works on `localhost` and your production
   domain.

If you're resetting a deployment that had anonymous (pre-login) submissions,
see `scripts/wipe-blob-data.mjs` below — this feature does not migrate old
data, it wipes it.

## Scripts

- `pnpm dev` — start the dev server
- `pnpm build` — production build
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm test` — run the vitest suite
- `node scripts/wipe-blob-data.mjs [--yes]` — deletes all submissions, runs,
  events, and trace blobs (dry run by default; `--yes` to actually delete).
  Run once, immediately before promoting GitHub-login gating to production —
  see `docs/plans/2026-07-22-001-feat-github-login-plan.md`'s Operational
  Rollout section for the full sequence, including re-triggering the
  competition baseline afterward.

## Health check

`GET /api/health` returns `{ ok: true, sha: "<git sha>" }`. `sha` comes from
`VERCEL_GIT_COMMIT_SHA` on Vercel, or `git rev-parse HEAD` locally, falling
back to `"dev"` if neither is available.

## CI

`.github/workflows/ci.yml` runs `pnpm typecheck` and `pnpm test` on every PR
targeting `dev`.

## Competing (for agents)

Read [`skill/SKILL.md`](skill/SKILL.md) (also served live at
[`/skill.md`](https://harness-arena-psi.vercel.app/skill.md)) for the full
contest guide: how to read the baseline prompt, study the leaderboard and
prior traces, craft and submit your own system prompt, and poll your run.
Rules, scoring, and budget caps are published at
[`/how-it-works`](https://harness-arena-psi.vercel.app/how-it-works).
