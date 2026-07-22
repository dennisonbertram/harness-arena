import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

import { GET } from "./route";

describe("GET /api/leaderboard", () => {
  beforeEach(() => {
    resetStorage();
  });

  it("returns an empty array when no completed runs exist", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("orders entries by tasks_passed desc, then total_cost_usd asc, and computes cost_per_task", async () => {
    await storageRef.current.putSubmission({
      id: "sub-a",
      agent_name: "agent-a",
      prompt: "prompt a",
      status: "scored",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await storageRef.current.putSubmission({
      id: "sub-b",
      agent_name: "agent-b",
      prompt: "prompt b",
      status: "scored",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await storageRef.current.putSubmission({
      id: "sub-c",
      agent_name: "agent-c",
      prompt: "prompt c",
      status: "scored",
      created_at: "2026-01-01T00:00:00.000Z",
    });

    // b: fewer tasks passed than a and c -> ranks last.
    await storageRef.current.putRun({
      id: "run-b",
      submission_id: "sub-b",
      status: "completed",
      tasks_passed: 4,
      total_cost_usd: 0.5,
      task_results: [],
      created_at: "2026-01-02T00:00:00.000Z",
    });
    // a and c tie on tasks_passed=8; a is cheaper so a ranks above c.
    await storageRef.current.putRun({
      id: "run-c",
      submission_id: "sub-c",
      status: "completed",
      tasks_passed: 8,
      total_cost_usd: 1.2,
      task_results: [],
      created_at: "2026-01-03T00:00:00.000Z",
    });
    await storageRef.current.putRun({
      id: "run-a",
      submission_id: "sub-a",
      status: "completed",
      tasks_passed: 8,
      total_cost_usd: 0.8,
      task_results: [],
      created_at: "2026-01-04T00:00:00.000Z",
    });

    const response = await GET();
    const body = await response.json();

    expect(body.map((e: { run_id: string }) => e.run_id)).toEqual(["run-a", "run-c", "run-b"]);
    expect(body.map((e: { rank: number }) => e.rank)).toEqual([1, 2, 3]);

    const first = body[0];
    expect(first.submission_id).toBe("sub-a");
    expect(first.agent_name).toBe("agent-a");
    expect(first.tasks_passed).toBe(8);
    expect(first.total_cost_usd).toBe(0.8);
    expect(first.cost_per_task).toBeCloseTo(0.08);
  });

  it("excludes runs that are not completed or are missing tasks_passed/total_cost_usd", async () => {
    await storageRef.current.putSubmission({
      id: "sub-d",
      agent_name: "agent-d",
      prompt: "prompt d",
      status: "queued",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await storageRef.current.putRun({
      id: "run-d",
      submission_id: "sub-d",
      status: "queued",
      task_results: [],
      created_at: "2026-01-01T00:00:00.000Z",
    });

    const response = await GET();
    expect(await response.json()).toEqual([]);
  });
});
