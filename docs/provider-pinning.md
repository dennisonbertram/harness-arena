# Provider pinning

**Every run recorded before this shipped is marked "to be deprecated" on the
board.** Skip to [Deprecating old runs](#deprecating-old-runs) for what that
means and what to do about it.

---

## The problem

The Vercel AI Gateway fans a single model id out across many upstream
providers. Asked directly on 2026-07-28:

| Model | Upstreams the gateway may use |
|---|---|
| `zai/glm-5.2` | alibaba, baseten, crusoe, deepinfra, digitalocean, fireworks, morph, nebius, novita, parasail, runware, streamlake, togetherai, wafer, zai — **fifteen** |
| `anthropic/claude-sonnet-5` | anthropic, bedrock, claudeaws, vertexAnthropic — **four** |

Those differ in quantisation, serving stack and version. An unpinned benchmark
therefore samples a different machine on every run, and we were attributing
that movement to the prompt.

Measured within-prompt sd is **0.78 tasks (4.8 points)**, against prompt
effects of ~5 points — see `docs/measurement-and-variance.md`. Pinning is the
only variance lever that costs nothing per run: it narrows the noise instead of
paying for more samples.

## Why it needs a proxy

The gateway honours `providerOptions.gateway.only` in the request **body**.
pi has no way to add arbitrary body fields:

- pi's own `providerOptions` is an **auth** concept (apiKey, baseUrl, headers),
  not the AI SDK's gateway options.
- pi's `openRouterRouting` has exactly the right shape (`only`, `order`,
  `ignore`, `quantizations`) but emits OpenRouter's `provider` field. **The
  Vercel gateway accepts that and silently ignores it** — verified:
  `provider.only: ["bogus"]` returns **200**, while
  `providerOptions.gateway.only: ["bogus"]` correctly returns **400**. Using it
  would have looked like it worked.

pi *can* point a provider at a different `baseUrl`. So we run a sidecar, point
pi at it, inject the pin server-side, and forward. **No pi fork, no vendored
patch.**

## How it works

```
pi (inside the task container)
  │  models.json: providers["vercel-ai-gateway"].baseUrl
  │               = http://host.docker.internal:4599/v1
  ▼
gateway-proxy.mjs (on the sandbox VM)
  │  injects providerOptions.gateway.only = ["zai"]
  ▼
https://ai-gateway.vercel.sh
```

- `scripts/runner/gateway-proxy.mjs` — the sidecar. Injects the pin, forwards
  everything else untouched, passes upstream errors through unchanged, and 502s
  loudly if the upstream is unreachable rather than hanging.
- `buildPinnedModelsConfig()` in `scripts/runner/lib.mjs` — the pi config.
- `--add-host host.docker.internal:host-gateway` on `docker run` — pi runs
  inside the task container; the proxy runs on the VM outside it.
- `PINNED_PROVIDERS` in `lib/arena-params.ts` — which upstream each model pins
  to. A model absent from that map is **not** pinned and behaves exactly as
  before.

Providers are pinned to the model's own first-party upstream where one exists,
so the benchmark measures a model as its authors serve it rather than whichever
reseller the gateway happened to pick.

Runs record `provider_pinned`, and only when a pin was actually applied.

## Deprecating old runs

**Absence of `provider_pinned` is the deprecation marker.** No backfill, no
timestamp to drift: a run either recorded which upstream it used, or it did not.

`isPrePinningRun()` in `lib/arena-params.ts` is the single definition.
`PromptStanding.prePinningRuns` counts them per standing, and `/benchmarks`
renders `⚠ n/m unpinned` on any affected row.

### What this means

- **Pre-pinning runs are not strictly comparable with pinned ones.** Each drew
  from an unknown mix of upstreams.
- **That includes the baselines.** A pinned entry ranked against an unpinned
  baseline is being compared to a different measurement.
- **A standing mixing both is averaging across a change in what was measured.**
  That is the case the warning most exists for.

### What to do

1. **Re-run the baselines first.** They are the reference every entry is judged
   against, so they should cross over before anything else.
2. **Re-run standings you care about**, or let them age out as new entries
   arrive.
3. **Do not silently drop the old runs.** They are real, public, and their
   traces are still worth reading — they are just not comparable.

## What is proven, and what is not

**Proven, against the live gateway:**

- `providerOptions.gateway.only` is enforced (a bogus value 400s and enumerates
  the real providers).
- The proxy injects it when the client sends nothing — pinned to `zai` returned
  200 and forwarded `only: ["zai"]`; pinned to `bogus-xyz` returned 400.
- End to end through pi's own generated `baseUrl`: HTTP 200, forwarded with the
  pin, `generationId` captured.

**Not proven: that this reduces variance.** That needs a before/after
measurement — the same prompt, N runs unpinned versus N pinned. At sd = 0.78
tasks, roughly 8–10 runs per side are needed to detect a meaningful change,
about **$30** of runs. Until that is done, pinning is a well-motivated
hypothesis, not a demonstrated improvement.

## Attribution

The OpenAI-compatible endpoint does **not** say which provider served a
response — it returns only `id, object, created, model, choices, usage,
system_fingerprint, generationId`. `providerMetadata.gateway.routing
.resolvedProvider` is an AI SDK feature not exposed here.

The proxy does capture `generationId` per call, which gateway observability may
be able to resolve to a provider after the fact. Not wired up yet; the pin
itself is what matters for comparability.

## Operating it

- Pin a model: add it to `PINNED_PROVIDERS`.
- Unpin: remove it. Its runs then record no `provider_pinned` and are marked
  unpinned, which is accurate.
- Override the port: `GATEWAY_PROXY_PORT` (default 4599).
- The sidecar now starts for **every** run, pinned or not. Two reasons: it is
  what captures the resolved system prompt (see below), and routing only *some*
  runs through a proxy would itself be a difference between them beyond the pin
  under test. Unpinned runs pass through it untouched -- `pinProviders` returns
  the body unchanged when nothing is pinned.

## Capturing the system prompt pi actually ran

A baseline submits an empty prompt by design -- that is what makes the runner
pass no `--system-prompt`, so pi builds its own default. Recording that as `""`
made the baseline look like it ran nothing.

It cannot be rebuilt from our side. pi's `buildSystemPrompt` assembles the
default at runtime from the container's own doc paths, tool set, cwd, project
context and skills, and pi does not persist the result: the session JSONL header
carries only `id`, `timestamp` and `cwd`. `docs/pi-vanilla-system-prompt.txt` is
what rebuilding it looks like -- a hand-edited snapshot that still points at
`/Users/dennison/.nvm/.../pi-coding-agent/README.md` and ends in a literal
`<cwd>` placeholder.

So the sidecar reads it off the wire instead. `systemPromptOf()` takes the
`system` message out of the request body -- the exact bytes pi sent -- and the
run records it as `resolved_system_prompt`. There is no reconstruction, so
there is nothing to drift on a pi upgrade.

The run page prefers that captured value and falls back to the snapshot only for
runs recorded before this shipped.

**Note on the two `buildSystemPrompt` branches.** Passing a custom prompt takes
a different branch from the default, but both append project context, skills and
the cwd line identically -- the only difference is the base text. So passing a
correctly-generated default would be equivalent *while it stayed correct*, and
would silently stop being the default the moment it drifted. Capturing avoids
that class of bug entirely, which is why the baseline still runs vanilla.
