import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchQueuedRuns, selectRunsToStart } from "./dispatch";
import { resetStorage, storageRef } from "./test-support/storage-ref";
import type { Run, Submission } from "./types";

function run(id: string, over: Partial<Run> = {}): Run {
  return {
    id,
    submission_id: over.submission_id ?? "sub-1",
    status: over.status ?? "queued",
    task_results: [],
    created_at: over.created_at ?? `2026-07-24T00:00:${id.padStart(2, "0")}.000Z`,
    ...over,
  };
}

describe("selectRunsToStart", () => {
  it("does not dispatch an uncommitted replay reservation", () => {
    const pendingReplay = run("00", { replay_operation_id: "7d9437f6-02fe-4da6-8d84-791b0ecf4690", replay_ready: false });
    const normal = run("01");
    expect(selectRunsToStart([pendingReplay, normal]).map((candidate) => candidate.id)).toEqual(["01"]);
  });
  it("returns nothing when there are no unclaimed queued runs", () => {
    expect(selectRunsToStart([run("1", { status: "running" })], 3, 2)).toEqual([]);
    expect(selectRunsToStart([], 3, 2)).toEqual([]);
  });

  it("starts oldest-first, bounded by the per-tick cap", () => {
    const runs = [run("03"), run("01"), run("02")];
    const picked = selectRunsToStart(runs, 5, 2).map((r) => r.id);
    expect(picked).toEqual(["01", "02"]); // oldest two by created_at
  });

  it("counts running and already-dispatched (claimed) runs as active", () => {
    const runs = [
      run("a", { status: "running" }),
      run("b", { status: "queued", dispatched_at: "2026-07-24T00:00:00.000Z" }),
      run("c", { status: "queued" }),
      run("d", { status: "queued" }),
    ];
    // cap 3, active = a + b = 2, so exactly 1 free slot
    const picked = selectRunsToStart(runs, 3, 5).map((r) => r.id);
    expect(picked).toEqual(["c"]);
  });

  it("returns nothing when already at the cap", () => {
    const runs = [run("a", { status: "running" }), run("b", { status: "running" }), run("c")];
    expect(selectRunsToStart(runs, 2, 5)).toEqual([]);
  });
});

describe("dispatchQueuedRuns", () => {
  beforeEach(() => resetStorage());

  async function seed(nRuns: number, submissionPrompt = "do the task") {
    const sub: Submission = {
      id: "sub-1",
      agent_name: "a",
      prompt: submissionPrompt,
      status: "queued",
      created_at: "2026-07-24T00:00:00.000Z",
    };
    await storageRef.current.putSubmission(sub);
    for (let i = 0; i < nRuns; i++) {
      await storageRef.current.putRun(run(String(i + 1).padStart(2, "0")));
    }
  }

  it("claims (persists dispatched_at) and starts runs up to the per-tick cap, passing the submission prompt", async () => {
    await seed(5);
    const startFn = vi.fn().mockResolvedValue(undefined);

    const started = await dispatchQueuedRuns(storageRef.current, startFn);

    // Default per-tick cap is 2, so exactly two of the five start this tick.
    expect(started).toHaveLength(2);
    expect(startFn).toHaveBeenCalledTimes(2);
    for (const id of started) {
      const persisted = await storageRef.current.getRun(id);
      expect(persisted?.dispatched_at).toBeDefined(); // claimed before the sandbox call
    }
    // startFn gets the claimed run + the submission's prompt.
    expect(startFn).toHaveBeenCalledWith(
      expect.objectContaining({ dispatched_at: expect.any(String) }),
      "do the task",
    );
  });

  it("does not start a run whose submission is missing (orphan)", async () => {
    await storageRef.current.putRun(run("01", { submission_id: "gone" }));
    const startFn = vi.fn().mockResolvedValue(undefined);

    const started = await dispatchQueuedRuns(storageRef.current, startFn);

    expect(started).toEqual([]);
    expect(startFn).not.toHaveBeenCalled();
  });
});
