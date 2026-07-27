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
