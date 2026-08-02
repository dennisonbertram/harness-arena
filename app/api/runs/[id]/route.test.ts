import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";
import { reapThresholdMs } from "@/lib/reaper";

const dispatchQueuedRuns = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});
vi.mock("@/lib/dispatch", () => ({ dispatchQueuedRuns }));

import { GET } from "./route";

describe("GET /api/runs/[id]", () => {
  beforeEach(() => {
    resetStorage();
    dispatchQueuedRuns.mockClear();
  });

  it("returns the run, including incrementally accumulated task_results, when it exists", async () => {
    await storageRef.current.putRun({
      id: "run-1",
      submission_id: "sub-1",
      status: "running",
      task_results: [{ task_id: "t1", attempted: true, passed: true }],
      created_at: "2026-07-21T00:00:00.000Z",
    });

    const response = await GET(new NextRequest("http://localhost/api/runs/run-1"), {
      params: Promise.resolve({ id: "run-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.id).toBe("run-1");
    expect(body.task_results).toEqual([{ task_id: "t1", attempted: true, passed: true }]);
  });

  it("returns 404 when the run does not exist", async () => {
    const response = await GET(new NextRequest("http://localhost/api/runs/unknown"), {
      params: Promise.resolve({ id: "unknown" }),
    });

    expect(response.status).toBe(404);
  });

  describe("lazy reap", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("marks a stale dispatched-queued run reaped and returns the reaped status, persisting the change", async () => {
      vi.useFakeTimers();
      const createdAt = "2026-07-21T00:00:00.000Z";
      vi.setSystemTime(new Date(new Date(createdAt).getTime() + reapThresholdMs() + 1000));
      // Dispatched (claimed) but its sandbox stalled -> a genuinely stuck run.
      // (An undispatched queued run is just waiting for a slot and is never reaped.)
      await storageRef.current.putRun({
        id: "run-stale",
        submission_id: "sub-1",
        status: "queued",
        dispatched_at: createdAt,
        task_results: [],
        created_at: createdAt,
      });

      const response = await GET(new NextRequest("http://localhost/api/runs/run-stale"), {
        params: Promise.resolve({ id: "run-stale" }),
      });
      const body = await response.json();

      expect(body.status).toBe("reaped");
      expect((await storageRef.current.getRun("run-stale"))?.status).toBe("reaped");
      await vi.waitFor(() => expect(dispatchQueuedRuns).toHaveBeenCalledWith(storageRef.current));
    });
  });
});
