import { afterEach, describe, expect, it, vi } from "vitest";

const mockCreateRunSandbox = vi.fn().mockResolvedValue({ sandbox_id: "sbx-1" });
vi.mock("./sandbox", () => ({
  createRunSandbox: (...args: unknown[]) => mockCreateRunSandbox(...args),
}));

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

describe("startRun", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockCreateRunSandbox.mockReset().mockResolvedValue({ sandbox_id: "sbx-1" });
  });

  it("delegates to createRunSandbox with the run and the submitted prompt", async () => {
    const run = makeRun();

    await startRun(run, "be careful");

    expect(mockCreateRunSandbox).toHaveBeenCalledWith(run, { prompt: "be careful" });
  });

  it("propagates a createRunSandbox rejection instead of swallowing it (the caller owns the fire-and-forget catch)", async () => {
    mockCreateRunSandbox.mockRejectedValueOnce(new Error("sandbox down"));

    await expect(startRun(makeRun(), "be careful")).rejects.toThrow("sandbox down");
  });

  it("does not take the hard-coded Vercel Sandbox path in explicit deterministic local mode", async () => {
    vi.stubEnv("HARNESS_EXECUTION_MODE", "deterministic-success");
    vi.stubEnv("HARNESS_LOCAL_INIT", "1");
    vi.stubEnv("HARNESS_GIT_BRANCH", "codex/deterministic-local-sandbox");
    vi.stubEnv("STORAGE", "file");

    await startRun(makeRun(), "be careful");

    expect(mockCreateRunSandbox).not.toHaveBeenCalled();
  });
});
