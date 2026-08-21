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

// The two boards. Values match SubmissionSchema/CompetitionSchema's benchmark
// enum (lib/types.ts) exactly; every row written before multiple boards
// existed has NO benchmark field, so absent means terminal-bench-2 — never
// treat absence as "unknown board".
export const TERMINAL_BENCH_BENCHMARK = "terminal-bench-2";
export const SWE_BENCHMARK = "swe-bench";
export type BenchmarkBoard = typeof TERMINAL_BENCH_BENCHMARK | typeof SWE_BENCHMARK;
export const DEFAULT_BENCHMARK = TERMINAL_BENCH_BENCHMARK as BenchmarkBoard;

/**
 * The board a row belongs to. Absent/unrecognized values fall back to the
 * default terminal-bench board so legacy rows render exactly as before.
 */
export function normalizeBenchmark(benchmark: string | undefined): BenchmarkBoard {
  return benchmark === SWE_BENCHMARK ? SWE_BENCHMARK : DEFAULT_BENCHMARK;
}

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
// the gateway happened to pick. GLM uses Together AI because both the
// first-party z.ai route and Morph proved too slow for this benchmark.
export const PINNED_PROVIDERS: Record<string, string> = {
  "zai/glm-5.2": "togetherai",
  // Wafer's advertised throughput is higher, but a live competition run
  // stopped returning output mid-task and hit the five-minute agent timeout.
  // Fireworks is the other provider currently serving this exact fast-model
  // slug, so pin it for reliable completion rather than headline throughput.
  "zai/glm-5.2-fast": "fireworks",
  "anthropic/claude-sonnet-5": "anthropic",
  "anthropic/claude-opus-5": "anthropic",
  "anthropic/claude-opus-4-8": "anthropic",
  // Vercel's live endpoint catalog reports Baseten as Inkling Small's sole
  // upstream, so this is both a deliberate pin and an explicit no-fallback
  // assertion.
  "thinkingmachines/inkling-small": "baseten",
};

// The swe-bench board's pins. Pinning is a property of the model+upstream
// pair, not of the board: both boards run the same model allowlist on the
// same gateway upstreams today. Kept as its own named constant (rather than
// having the swe board read PINNED_PROVIDERS directly) so a future
// board-specific pin — a provider that serves SWE repos well but
// Terminal-Bench poorly — diverges deliberately instead of silently.
export const SWE_PINNED_PROVIDERS: Record<string, string> = { ...PINNED_PROVIDERS };

/**
 * A run recorded before provider pinning shipped. Its model calls were served
 * by an unknown mix of upstreams, so it is not strictly comparable with a
 * pinned run -- including for the baseline it may be ranked against.
 */
export function isPrePinningRun(run: { provider_pinned?: string }): boolean {
  return run.provider_pinned === undefined;
}
