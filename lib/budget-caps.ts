import { TERMINAL_BENCH_BENCHMARK, SWE_BENCHMARK, type BenchmarkBoard } from "./arena-params";

// Per-board per-run spend ceilings, injected into the runner as BUDGET_CAP_USD
// (runner.mjs enforces the cap; this module is the single source of the
// numbers). Extracted from the inline default that used to live in
// lib/sandbox.ts so a board's cap is named once and testable.
//
// The terminal-bench figure must stay identical to the displayed per-run cap
// (PER_RUN_BUDGET_CAP_USD in lib/status-view.ts) — budget-caps.test.ts pins
// the two together.

export const TERMINAL_BENCH_RUN_BUDGET_CAP_USD = 2;

// TUNABLE — derived from Phase-0 spike data: SWE runs are longer (repo setup,
// multi-file patches, full-suite verification), so the swe-bench board carries
// its own higher ceiling. Revisit after the first real SWE runs land.
export const SWE_RUN_BUDGET_CAP_USD = 6;

function boardDefault(benchmark: BenchmarkBoard): number {
  return benchmark === SWE_BENCHMARK ? SWE_RUN_BUDGET_CAP_USD : TERMINAL_BENCH_RUN_BUDGET_CAP_USD;
}

// Structural env view so both process.env and plain test fixtures fit.
export type BudgetCapEnv = { [key: string]: string | undefined };

/**
 * Resolves the BUDGET_CAP_USD value for one run. RUN_MODE selects the board
 * (same convention tasks-for-runner.buildRunnerTasks uses: "swe" serves the
 * swe-bench specs); an explicit positive RUN_BUDGET_CAP_USD overrides either
 * board's default as the ops escape hatch.
 */
export function resolveRunBudgetCapUsd(env: BudgetCapEnv): number {
  const benchmark: BenchmarkBoard =
    (env.RUN_MODE ?? "").trim() === "swe" ? SWE_BENCHMARK : TERMINAL_BENCH_BENCHMARK;
  const override = Number(env.RUN_BUDGET_CAP_USD);
  if (Number.isFinite(override) && override > 0) return override;
  return boardDefault(benchmark);
}
