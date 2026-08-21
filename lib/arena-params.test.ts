import { describe, expect, it } from "vitest";
import {
  DEFAULT_BENCHMARK,
  normalizeBenchmark,
  PINNED_PROVIDERS,
  SWE_BENCHMARK,
  SWE_PINNED_PROVIDERS,
  TERMINAL_BENCH_BENCHMARK,
} from "./arena-params";

describe("board constants", () => {
  it("names the two boards exactly as the SubmissionSchema/CompetitionSchema benchmark enum does", () => {
    expect(TERMINAL_BENCH_BENCHMARK).toBe("terminal-bench-2");
    expect(SWE_BENCHMARK).toBe("swe-bench");
    expect(DEFAULT_BENCHMARK).toBe("terminal-bench-2");
  });

  it("normalizes an absent benchmark field to terminal-bench-2 (every legacy row predates boards)", () => {
    expect(normalizeBenchmark(undefined)).toBe("terminal-bench-2");
  });

  it("passes each known board value through unchanged", () => {
    expect(normalizeBenchmark("terminal-bench-2")).toBe("terminal-bench-2");
    expect(normalizeBenchmark("swe-bench")).toBe("swe-bench");
  });

  it("falls back to the default board for anything else rather than inventing a third board", () => {
    expect(normalizeBenchmark("kaggle")).toBe("terminal-bench-2");
  });
});

describe("SWE_PINNED_PROVIDERS", () => {
  // Pinning is a property of the model+upstream pair, not of the board: both
  // boards run the same model allowlist on the same gateway upstreams today.
  // If a board-specific pin is ever needed, it diverges deliberately — this
  // test pins today's consistency so a drift is a decision, not an accident.
  it("pins the same models to the same upstreams as the terminal-bench board", () => {
    expect(SWE_PINNED_PROVIDERS).toEqual(PINNED_PROVIDERS);
  });

  it("includes the swe-bench board's default model pin", () => {
    expect(SWE_PINNED_PROVIDERS["zai/glm-5.2"]).toBeDefined();
  });
});
