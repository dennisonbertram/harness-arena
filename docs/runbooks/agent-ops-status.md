# Agent operations status

Run the passive status collector with an explicit environment:

```sh
pnpm ops:status --env production --json
pnpm ops:status --env production
pnpm ops:status --env development --json
pnpm ops:status --env local
```

Remote ops API access uses `OPS_READ_TOKEN` from the process environment. Do not pass tokens on the command line. Remote origins are derived from `config/development-environment.json` and are intentionally not overrideable: production reads only the live `main` host/project, while Development reads only the isolated `dev` host/project. Local defaults to `http://127.0.0.1:3000` and skips platform commands.

The requested `development` environment is labeled `development` in output but reads the isolated `harness-arena-development` project’s Vercel `production` target: Vercel’s target label does not change the repository’s Development-only boundary. Production maps only to the live project’s Vercel `production` target; local performs no Vercel or GitHub inspection.

The collector only issues allowlisted application GETs. Remote environments also run exact read-only command shapes for Vercel deployment list/inspect, environment metadata listing, recent logs, and the expected GitHub ref SHA. Vercel environment values are never retained. Mutation subcommands, option-shaped targets, shell execution, and command-line tokens are rejected.

Exit codes:

- `0`: healthy; all required evidence is present and consistent.
- `1`: degraded; evidence is partial, stale, contradictory, or unknown without a proven failure.
- `2`: failed; health, malformed ops-root or run inventory evidence, any unreadable/corrupt/event-hole integrity evidence, runtime errors, required metadata, deployment drift, or a serving deployment without an identified `READY` state and nonempty SHA/ref proves an operational failure.
- `3`: access blocked; HTTP authorization or required local command access prevented inspection.
- `64`: invalid CLI usage.

The JSON contract is `agent_ops_status.v1`. Inventory reads are capped at 20 advertised kinds, 10 pages per kind, and 100 records per page. Run/event correlation reads at most 20 runs. Application requests retry once only for timeouts, transport errors, HTTP 429, and HTTP 5xx. Subprocesses have time and output bounds and are terminated with `SIGTERM`, then `SIGKILL` after a short grace period.

Unavailable evidence stays explicit. In particular, every inventory page must contain `has_more` and `next_cursor` (`null` only on terminal pages, a nonempty string otherwise); missing or malformed fields never pass. Advertised kinds beyond the 20-kind cap, malformed run records, runs beyond the 20-run correlation cap, unknown freshness, absent cron metadata, command failures, missing environment-name metadata, and missing run correlation fields never produce a healthy verdict. The JSON includes advertised/valid/selected/invalid counts and a `truncated` flag for bounded scopes.
