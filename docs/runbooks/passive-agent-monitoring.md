# Passive agent monitoring

`.github/workflows/passive-agent-monitor.yml` runs at minute 17 and 47 of each hour. It has only `contents: read` and `issues: write`. It collects the existing bounded, GET-only status evidence, retains only sanitized JSON artifacts for 14 days, and opens or reuses an `agent-monitor` issue for each stable failure fingerprint.

Development receives `HARNESS_ARENA_DEVELOPMENT_OPS_READ_TOKEN` only as an Actions secret after the separate Development project exists. Do not put a Vercel, Blob, callback, gateway, admin, or live credential in this workflow. The production invocation deliberately runs without an ops token and must report `access_blocked` when authenticated production evidence is unavailable; it must never escalate privileges.

Incident transitions are deterministic: a new fingerprint creates one issue; repeats are silent; an unchanged failure on a changed deployment adds evidence to the same issue; the first healthy observation comments `recovery_pending`; a second consecutive healthy observation closes it; a recurrence reopens that exact issue. Monitor execution failures create a separate `monitor` alert class, never masquerading as product failures.

The retained evidence contains timestamp, environment, deployment ID/SHA, finding codes, and safe request/trace identifiers if the status source provides them. It excludes credential values, authorization headers, prompts, request bodies, and raw error payloads.

## Local controlled smoke

Run the status collector against a fixture or controlled Development outage, save its JSON, then generate a plan without invoking GitHub:

```sh
node scripts/ops/agent-status.mjs --env local --json > /tmp/monitor-status.json
printf '[]' > /tmp/monitor-incidents.json
node scripts/ops/passive-monitor.mjs --environment development --status /tmp/monitor-status.json --incidents /tmp/monitor-incidents.json --output /tmp/monitor-plan.json
```

For a live proof after review, manually dispatch the workflow against Development, inspect the sanitized artifact and single incident, restore the controlled fault, then verify recovery and a later repeat check. Inspect production only through the passive evidence and confirm no live mutation occurred. Rollback is disabling this workflow; it changes no application or infrastructure state.
