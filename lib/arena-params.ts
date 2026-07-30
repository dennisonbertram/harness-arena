// The fixed board's runtime parameters — what every submission is tested
// against. Model/endpoint mirror the runner defaults (scripts/runner/runner.mjs:
// RUNNER_MODEL / RUNNER_PROVIDER); the harness is pi, driven via the agentkit
// baked into the sandbox snapshot (lib/sandbox.ts); tasks are vendored from
// Terminal-Bench 2.0 (scripts/vendor-tasks.sh). Kept in one place so the
// /benchmarks board, footer, and task pages can't drift from each other.
export const ARENA_MODEL = "zai/glm-5.2";
export const ARENA_HARNESS = "pi";
export const ARENA_ENDPOINT = "Vercel AI Gateway";
export const ARENA_BENCHMARK = "Terminal-Bench 2.0";
export const ARENA_BENCHMARK_URL = "https://github.com/laude-institute/terminal-bench-2";

// Who sees the Rerun control on /benchmarks. This is a UI affordance only:
// Rerun posts to POST /api/submissions, the same public endpoint the Submit
// page uses, which accepts any signed-in GitHub user by design. Hiding the
// button stops it inviting visitors to spend money re-running other people's
// prompts; it is NOT an authorization boundary. Gating the endpoint itself
// would be a server change.
export const RERUN_OPERATOR_LOGIN = process.env.RERUN_OPERATOR_LOGIN ?? "dennisonbertram";
// The gateway providers each model is pinned to. A model absent here is not
// pinned, and its runs stay comparable only to other unpinned runs.
//
// Keep each model on one deliberate upstream rather than whichever provider
// the gateway happened to pick. GLM uses Morph because the first-party z.ai
// route proved too slow for this benchmark.
export const PINNED_PROVIDERS: Record<string, string> = {
  "zai/glm-5.2": "morph",
  "anthropic/claude-sonnet-5": "anthropic",
  "anthropic/claude-opus-5": "anthropic",
  "anthropic/claude-opus-4-8": "anthropic",
};

/**
 * A run recorded before provider pinning shipped. Its model calls were served
 * by an unknown mix of upstreams, so it is not strictly comparable with a
 * pinned run -- including for the baseline it may be ranked against.
 */
export function isPrePinningRun(run: { provider_pinned?: string }): boolean {
  return run.provider_pinned === undefined;
}
