import { describe, expect, it } from "vitest";
import { RUN_STATUS_BADGE_STYLES, shouldPollRunStatus } from "./run-status";
import { RUN_STATUSES } from "./types";

describe("shouldPollRunStatus", () => {
  it("keeps polling while a run is queued", () => {
    expect(shouldPollRunStatus("queued")).toBe(true);
  });

  it("keeps polling while a run is running", () => {
    expect(shouldPollRunStatus("running")).toBe(true);
  });

  it("stops polling once a run completes", () => {
    expect(shouldPollRunStatus("completed")).toBe(false);
  });

  it("stops polling once a run fails", () => {
    expect(shouldPollRunStatus("failed")).toBe(false);
  });

  it("stops polling once a run is reaped", () => {
    expect(shouldPollRunStatus("reaped")).toBe(false);
  });

  it("regression: polls for exactly running/queued across every known RUN_STATUSES value", () => {
    // Walks the authoritative status list from lib/types.ts instead of a
    // hardcoded set, so adding a new status there without updating the
    // poller's active-set fails this test rather than silently polling (or
    // not polling) forever.
    for (const status of RUN_STATUSES) {
      const expected = status === "running" || status === "queued";
      expect(shouldPollRunStatus(status)).toBe(expected);
    }
  });
});

describe("RUN_STATUS_BADGE_STYLES", () => {
  it("uses blue-800 (not blue-700) for the completed badge text so it meets the 4.5:1 contrast minimum on blue-100", () => {
    // blue-700 on blue-100 measures ~4.28:1, below WCAG AA's 4.5:1 for normal
    // text; blue-800 on blue-100 measures ~5.34:1.
    expect(RUN_STATUS_BADGE_STYLES.completed.fg).toBe("var(--blue-800)");
  });

  describe("regression: contrast ratio, not just token name", () => {
    // Hex values mirror the light-theme tokens in app/globals.css. Checking
    // the actual fg/bg contrast math catches a regression even if a future
    // edit swaps in some other token pairing that still fails 4.5:1.
    const TOKEN_HEX: Record<string, string> = {
      "var(--blue-100)": "#f0f7ff",
      "var(--blue-700)": "#006bff",
      "var(--blue-800)": "#0059ec",
    };

    function contrastRatio(hexA: string, hexB: string): number {
      const luminance = (hex: string) => {
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255);
        const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const [lighter, darker] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a);
      return (lighter + 0.05) / (darker + 0.05);
    }

    it("keeps the completed badge's fg/bg pairing at or above 4.5:1", () => {
      const { fg, bg } = RUN_STATUS_BADGE_STYLES.completed;
      const ratio = contrastRatio(TOKEN_HEX[fg], TOKEN_HEX[bg]);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
      // Sanity check that the old blue-700 pairing would in fact have
      // failed — proves this test can catch the original bug.
      expect(contrastRatio(TOKEN_HEX["var(--blue-700)"], TOKEN_HEX["var(--blue-100)"])).toBeLessThan(4.5);
    });
  });
});
