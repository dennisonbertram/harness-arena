import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
