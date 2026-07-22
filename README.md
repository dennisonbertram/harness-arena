# harness-arena

Next.js (App Router, TypeScript strict) scaffold for Harness Arena.

## Getting started

```bash
cp .env.example .env.local   # fill in real values locally, never commit
pnpm install
pnpm dev
```

## Scripts

- `pnpm dev` — start the dev server
- `pnpm build` — production build
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm test` — run the vitest suite

## Health check

`GET /api/health` returns `{ ok: true, sha: "<git sha>" }`. `sha` comes from
`VERCEL_GIT_COMMIT_SHA` on Vercel, or `git rev-parse HEAD` locally, falling
back to `"dev"` if neither is available.

## CI

`.github/workflows/ci.yml` runs `pnpm typecheck` and `pnpm test` on every PR
targeting `dev`.
