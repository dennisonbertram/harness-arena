import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

import { GET } from "./route";

describe("GET /api/cron/reap", () => {
  beforeEach(() => {
    resetStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reaps every stale run and reports the reaped count, leaving fresh runs alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:11:00.000Z"));
    await storageRef.current.putRun({
      id: "run-stale",
      submission_id: "sub-1",
      status: "queued",
      task_results: [],
      created_at: "2026-07-21T00:00:00.000Z",
    });
    await storageRef.current.putRun({
      id: "run-fresh",
      submission_id: "sub-2",
      status: "queued",
      task_results: [],
      created_at: "2026-07-21T00:09:00.000Z",
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reaped).toBe(1);
    expect((await storageRef.current.getRun("run-stale"))?.status).toBe("reaped");
    expect((await storageRef.current.getRun("run-fresh"))?.status).toBe("queued");
  });

  it("reports zero reaped when no runs are stale", async () => {
    await storageRef.current.putRun({
      id: "run-ok",
      submission_id: "sub-1",
      status: "completed",
      task_results: [],
      created_at: "2020-01-01T00:00:00.000Z",
    });

    const response = await GET();
    const body = await response.json();

    expect(body.reaped).toBe(0);
  });
});
