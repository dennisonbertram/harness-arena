import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

import { GET } from "./route";

describe("GET /api/runs/[id]", () => {
  beforeEach(() => {
    resetStorage();
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

    it("marks a stale queued run reaped and returns the reaped status, persisting the change", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-21T00:11:00.000Z"));
      await storageRef.current.putRun({
        id: "run-stale",
        submission_id: "sub-1",
        status: "queued",
        task_results: [],
        created_at: "2026-07-21T00:00:00.000Z",
      });

      const response = await GET(new NextRequest("http://localhost/api/runs/run-stale"), {
        params: Promise.resolve({ id: "run-stale" }),
      });
      const body = await response.json();

      expect(body.status).toBe("reaped");
      expect((await storageRef.current.getRun("run-stale"))?.status).toBe("reaped");
    });
  });
});
