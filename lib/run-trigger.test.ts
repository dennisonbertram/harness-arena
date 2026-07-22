import { describe, expect, it, vi } from "vitest";
import { startRun } from "./run-trigger";
import type { Run } from "./types";

function makeRun(): Run {
  return {
    id: "run-1",
    submission_id: "sub-1",
    status: "queued",
    task_results: [],
    created_at: "2026-07-21T00:00:00.000Z",
  };
}

describe("startRun (stub for ticket #7)", () => {
  it("resolves without throwing so a submission is never failed by the missing sandbox trigger", async () => {
    await expect(startRun(makeRun())).resolves.toBeUndefined();
  });

  it("logs that the run trigger is not implemented yet, instead of silently no-op'ing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await startRun(makeRun());

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("run-trigger: not implemented (ticket #7)"));

    logSpy.mockRestore();
  });
});
