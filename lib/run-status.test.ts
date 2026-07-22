import { describe, expect, it } from "vitest";
import { RUN_STATUS_BADGE_STYLES, shouldPollRunStatus } from "./run-status";

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
});

describe("RUN_STATUS_BADGE_STYLES", () => {
  it("uses blue-800 (not blue-700) for the completed badge text so it meets the 4.5:1 contrast minimum on blue-100", () => {
    // blue-700 on blue-100 measures ~4.28:1, below WCAG AA's 4.5:1 for normal
    // text; blue-800 on blue-100 measures ~5.34:1.
    expect(RUN_STATUS_BADGE_STYLES.completed.fg).toBe("var(--blue-800)");
  });
});
