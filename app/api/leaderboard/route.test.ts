import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";
import { getTasks } from "@/lib/tasks";
import type { Run, Submission, TaskResult } from "@/lib/types";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

import { GET } from "./route";

const TASKS = getTasks();

// A run passing `passCount` of the benchmark's tasks (the rest fail).
function runResults(passCount: number): TaskResult[] {
  return TASKS.map((task, i) => ({ task_id: task.id, attempted: true, passed: i < passCount }));
}

async function seed(sub: Submission, run: Partial<Run> & { id: string; passCount: number }) {
  await storageRef.current.putSubmission(sub);
  await storageRef.current.putRun({
    id: run.id,
    submission_id: sub.id,
    status: "completed",
    tasks_passed: run.passCount,
    total_cost_usd: run.total_cost_usd,
    task_results: runResults(run.passCount),
    created_at: run.created_at ?? "2026-01-02T00:00:00.000Z",
  });
}

function submission(id: string, agent: string, prompt: string): Submission {
  return { id, agent_name: agent, prompt, status: "scored", created_at: "2026-01-01T00:00:00.000Z" };
}

describe("GET /api/leaderboard", () => {
  beforeEach(() => {
    resetStorage();
  });

  it("returns an empty array when no completed runs exist", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("ranks prompts by mean pass rate descending (the primary parameter)", async () => {
    await seed(submission("s-hi", "high", "P-HIGH"), { id: "r-hi", passCount: TASKS.length, total_cost_usd: 5.0 });
    await seed(submission("s-lo", "low", "P-LOW"), { id: "r-lo", passCount: 2, total_cost_usd: 0.2 });

    const body = await (await GET()).json();

    expect(body.map((e: { agent_name: string }) => e.agent_name)).toEqual(["high", "low"]);
    expect(body[0].rank).toBe(1);
    expect(body[0].pass_rate).toBeCloseTo(1);
    expect(body[0].completes_test).toBe(true);
    expect(body[1].pass_rate).toBeCloseTo(2 / TASKS.length);
  });

  it("aggregates repeated runs of the same prompt into one entry with a mean rate", async () => {
    const sub = submission("s1", "vanilla", ""); // empty prompt = baseline
    await storageRef.current.putSubmission(sub);
    // Two runs of the same prompt: first passes tasks 0-1, second passes task 0.
    await storageRef.current.putRun({
      id: "r1",
      submission_id: "s1",
      status: "completed",
      tasks_passed: 2,
      total_cost_usd: 1.0,
      task_results: runResults(2),
      created_at: "2026-01-02T00:00:00.000Z",
    });
    await storageRef.current.putRun({
      id: "r2",
      submission_id: "s1",
      status: "completed",
      tasks_passed: 1,
      total_cost_usd: 1.0,
      task_results: runResults(1),
      created_at: "2026-01-03T00:00:00.000Z",
    });

    const body = await (await GET()).json();
    expect(body).toHaveLength(1);
    expect(body[0].runs).toBe(2);
    expect(body[0].is_baseline).toBe(true);
    expect(body[0].pass_rate).toBeCloseTo(1.5 / TASKS.length); // mean of 2 and 1 tasks
    // per-task rate carries the variance signal: task 0 passed both runs, task 1
    // only one, the last task never.
    const byId = Object.fromEntries(
      body[0].per_task.map((t: { task_id: string; passed: number; of: number }) => [t.task_id, `${t.passed}/${t.of}`]),
    );
    expect(byId[TASKS[0].id]).toBe("2/2");
    expect(byId[TASKS[1].id]).toBe("1/2");
    expect(byId[TASKS[TASKS.length - 1].id]).toBe("0/2");
  });
});
