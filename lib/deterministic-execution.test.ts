import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRunnerTasks } from "./tasks-for-runner";
import { resetStorage, storageRef } from "./test-support/storage-ref";
import type { Run, Submission } from "./types";

const mockSandboxCreate = vi.fn();
vi.mock("@vercel/sandbox", () => ({ Sandbox: { create: mockSandboxCreate } }));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

import { executeDeterministicRun } from "./deterministic-execution";

const originalFetch = globalThis.fetch;

function records(id: string): { run: Run; submission: Submission } {
  const created_at = new Date().toISOString();
  return {
    run: { id, submission_id: `sub-${id}`, status: "queued", task_results: [], created_at },
    submission: { id: `sub-${id}`, agent_name: "local-smoke", prompt: "", status: "queued", created_at },
  };
}

beforeEach(() => {
  resetStorage();
  mockSandboxCreate.mockReset();
  globalThis.fetch = vi.fn(() => { throw new Error("deterministic mode attempted network access"); }) as typeof fetch;
  vi.stubEnv("RUNNER_CALLBACK_SECRET", "deterministic-test-secret");
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("HARNESS_EXECUTION_MODE", "deterministic-success");
  vi.stubEnv("HARNESS_LOCAL_INIT", "1");
  vi.stubEnv("HARNESS_GIT_BRANCH", "codex/deterministic-local-sandbox");
  vi.stubEnv("STORAGE", "file");
  vi.stubEnv("LOCAL_INSTANCE_PORT", "4123");
  for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_REGION", "VERCEL_PROJECT_ID"]) vi.stubEnv(key, "");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

describe("deterministic local execution", () => {
  it("derives the complete successful lifecycle from the runner task manifest and persists traces/totals", async () => {
    const { run, submission } = records("run-success");
    await storageRef.current.putSubmission(submission);
    await storageRef.current.putRun(run);
    await storageRef.current.appendRunEvents(run.id, [{ ts: run.created_at, type: "run.created", payload: { submission_id: submission.id } }]);

    await executeDeterministicRun(run, { prompt: "", scenario: "success" });

    const taskIds = buildRunnerTasks().map((task) => task.id);
    const events = await storageRef.current.listRunEvents(run.id);
    const expectedTaskEvents = taskIds.flatMap(() => [
      "task.started", "task.agent_finished", "task.verify_started", "task.verified", "task.trace_uploaded",
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "run.created", "run.sandbox_creating", "run.sandbox_ready", ...expectedTaskEvents, "run.completed",
    ]);
    const stored = await storageRef.current.getRun(run.id);
    expect(stored).toMatchObject({
      status: "completed",
      sandbox_id: `local-${run.id}`,
      tasks_passed: taskIds.length,
      total_cost_usd: 0,
      over_budget: false,
    });
    expect(stored?.task_results.map((result) => result.task_id)).toEqual(taskIds);
    expect(stored?.task_results.every((result) => result.trace_blob_url?.startsWith("http://127.0.0.1:4123/"))).toBe(true);
    expect(events.every((event) => Date.parse(event.ts) <= Date.parse(stored?.finished_at ?? ""))).toBe(true);
    for (const taskId of taskIds) {
      await expect(storageRef.current.getTraceBytes(run.id, taskId, "session.jsonl")).resolves.not.toBeNull();
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockSandboxCreate).not.toHaveBeenCalled();
  });

  it("matches runner parity for agent failure: no verifier events are emitted for the failed task", async () => {
    const { run, submission } = records("run-task-failure-parity");
    await storageRef.current.putSubmission(submission);
    await storageRef.current.putRun(run);
    await executeDeterministicRun(run, { prompt: "non-empty", scenario: "task-failure" });

    const firstTaskId = buildRunnerTasks()[0].id;
    const events = (await storageRef.current.listRunEvents(run.id)).filter((event) => event.payload.task_id === firstTaskId);
    expect(events.map((event) => event.type)).toEqual([
      "task.started", "task.agent_finished", "task.failed", "task.trace_uploaded",
    ]);
  });

  it("matches runner parity for budget exhaustion: every remaining manifest task is unattempted", async () => {
    const { run, submission } = records("run-budget-parity");
    await storageRef.current.putSubmission(submission);
    await storageRef.current.putRun(run);
    await executeDeterministicRun(run, { prompt: "non-empty", scenario: "budget-exceeded" });

    const stored = await storageRef.current.getRun(run.id);
    const taskIds = buildRunnerTasks().map((task) => task.id);
    expect(stored?.task_results.map((result) => result.task_id)).toEqual(taskIds);
    expect(stored?.task_results.map((result) => result.attempted)).toEqual([
      true, ...taskIds.slice(1).map(() => false),
    ]);
    expect(stored).toMatchObject({ tasks_passed: 1, total_cost_usd: 0.02, over_budget: true });
  });

  it.each([
    ["task-failure", "completed", "task.failed", false],
    ["callback-failure", "failed", "run.failed", undefined],
    ["stale-reap", "reaped", "run.reaped", undefined],
    ["budget-exceeded", "completed", "run.budget_exceeded", true],
  ] as const)("selects %s deterministically", async (scenario, status, eventType, overBudget) => {
    const { run, submission } = records(`run-${scenario}`);
    await storageRef.current.putSubmission(submission);
    await storageRef.current.putRun(run);
    await storageRef.current.appendRunEvents(run.id, [{ ts: run.created_at, type: "run.created", payload: {} }]);

    await executeDeterministicRun(run, { prompt: "", scenario });

    const stored = await storageRef.current.getRun(run.id);
    expect(stored?.status).toBe(status);
    if (overBudget !== undefined) expect(stored?.over_budget).toBe(overBudget);
    expect((await storageRef.current.listRunEvents(run.id)).some((event) => event.type === eventType)).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockSandboxCreate).not.toHaveBeenCalled();
  });
});
