import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

import { GET } from "./route";

describe("GET /api/runs", () => {
  beforeEach(() => {
    resetStorage();
  });

  it("returns an empty array when no runs exist", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("returns runs newest first", async () => {
    await storageRef.current.putRun({
      id: "run-old",
      submission_id: "sub-1",
      status: "completed",
      task_results: [],
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await storageRef.current.putRun({
      id: "run-new",
      submission_id: "sub-2",
      status: "queued",
      task_results: [],
      created_at: "2026-02-01T00:00:00.000Z",
    });

    const response = await GET();
    const body = await response.json();

    expect(body.map((r: { id: string }) => r.id)).toEqual(["run-new", "run-old"]);
  });

  describe("lazy reap", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("marks a stale running run reaped before returning it, and persists the change", async () => {
      vi.useFakeTimers();
      // Reap threshold raised to 20 minutes (issue #23 finding F5).
      vi.setSystemTime(new Date("2026-07-21T00:21:00.000Z"));
      await storageRef.current.putRun({
        id: "run-stale",
        submission_id: "sub-1",
        status: "running",
        task_results: [],
        created_at: "2026-07-21T00:00:00.000Z",
      });

      const response = await GET();
      const body = await response.json();

      expect(body.find((r: { id: string }) => r.id === "run-stale").status).toBe("reaped");
      expect((await storageRef.current.getRun("run-stale"))?.status).toBe("reaped");
    });

    it("leaves a fresh running run untouched", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-21T00:05:00.000Z"));
      await storageRef.current.putRun({
        id: "run-fresh",
        submission_id: "sub-2",
        status: "running",
        task_results: [],
        created_at: "2026-07-21T00:00:00.000Z",
      });

      const response = await GET();
      const body = await response.json();

      expect(body.find((r: { id: string }) => r.id === "run-fresh").status).toBe("running");
    });
  });
});
