import { describe, expect, it } from "vitest";
import { PER_RUN_BUDGET_CAP_USD } from "./status-view";
import {
  SWE_RUN_BUDGET_CAP_USD,
  TERMINAL_BENCH_RUN_BUDGET_CAP_USD,
  resolveRunBudgetCapUsd,
} from "./budget-caps";

describe("budget caps", () => {
  it("keeps the terminal-bench cap at the displayed $2/run figure (single source of truth, no drift)", () => {
    expect(TERMINAL_BENCH_RUN_BUDGET_CAP_USD).toBe(2);
    expect(TERMINAL_BENCH_RUN_BUDGET_CAP_USD).toBe(PER_RUN_BUDGET_CAP_USD);
  });

  it("gives the swe-bench board its own higher cap ($6 — TUNABLE from Phase-0 spike data)", () => {
    expect(SWE_RUN_BUDGET_CAP_USD).toBe(6);
    expect(SWE_RUN_BUDGET_CAP_USD).toBeGreaterThan(TERMINAL_BENCH_RUN_BUDGET_CAP_USD);
  });

  it("resolves the terminal-bench cap when RUN_MODE is unset (legacy default board)", () => {
    expect(resolveRunBudgetCapUsd({})).toBe(2);
    expect(resolveRunBudgetCapUsd({ RUN_MODE: "terminal-bench" })).toBe(2);
  });

  it("resolves the swe-bench cap when RUN_MODE=swe", () => {
    expect(resolveRunBudgetCapUsd({ RUN_MODE: "swe" })).toBe(6);
  });

  it("trims RUN_MODE the same way tasks-for-runner does", () => {
    expect(resolveRunBudgetCapUsd({ RUN_MODE: " swe " })).toBe(6);
  });

  it("lets an explicit RUN_BUDGET_CAP_USD override either board's default", () => {
    expect(resolveRunBudgetCapUsd({ RUN_BUDGET_CAP_USD: "5.5" })).toBe(5.5);
    expect(resolveRunBudgetCapUsd({ RUN_MODE: "swe", RUN_BUDGET_CAP_USD: "9" })).toBe(9);
  });

  it("falls back to the board default when RUN_BUDGET_CAP_USD is not a positive number", () => {
    expect(resolveRunBudgetCapUsd({ RUN_BUDGET_CAP_USD: "abc" })).toBe(2);
    expect(resolveRunBudgetCapUsd({ RUN_BUDGET_CAP_USD: "0" })).toBe(2);
    expect(resolveRunBudgetCapUsd({ RUN_BUDGET_CAP_USD: "-3" })).toBe(2);
    expect(resolveRunBudgetCapUsd({ RUN_MODE: "swe", RUN_BUDGET_CAP_USD: "" })).toBe(6);
  });
});
