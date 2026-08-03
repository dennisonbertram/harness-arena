import { NextRequest } from "next/server";
import { assertDeterministicLocalEnvironment } from "./development-identity";
import { getStorage } from "./storage";
import { buildRunnerTasks } from "./tasks-for-runner";
import type { NewRunEvent, Run, TaskResult } from "./types";

export const DETERMINISTIC_SCENARIOS = [
  "success",
  "task-failure",
  "callback-failure",
  "stale-reap",
  "budget-exceeded",
] as const;
export type DeterministicScenario = (typeof DETERMINISTIC_SCENARIOS)[number];

function deterministicTimestamp(run: Run, offset: number): string {
  const base = Date.parse(run.created_at);
  return new Date((Number.isFinite(base) ? base : 0) + offset * 1000).toISOString();
}

async function callback(runId: string, body: unknown, secret: string): Promise<Response> {
  const { POST } = await import("@/app/api/runs/[id]/callback/route");
  return POST(new NextRequest(`http://127.0.0.1/api/runs/${runId}/callback`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-secret": secret },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: runId }) });
}

async function trace(runId: string, taskId: string, body: string, secret: string): Promise<Response> {
  const { POST } = await import("@/app/api/runs/[id]/trace/route");
  const query = new URLSearchParams({ task_id: taskId, name: "session.jsonl" });
  return POST(new NextRequest(`http://127.0.0.1/api/runs/${runId}/trace?${query}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-runner-secret": secret },
    body,
  }), { params: Promise.resolve({ id: runId }) });
}

async function requireAccepted(response: Response, stage: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`deterministic ${stage} rejected (${response.status})`);
  return response.json() as Promise<Record<string, unknown>>;
}

async function markFailed(run: Run, message: string, stage: string, offset: number): Promise<void> {
  const storage = getStorage();
  const failed = { ...(await storage.getRun(run.id) ?? run), status: "failed" as const, finished_at: deterministicTimestamp(run, offset) };
  await storage.putRun(failed);
  await storage.appendRunEvents(run.id, [{
    ts: deterministicTimestamp(run, offset), type: "run.failed", payload: { error: message, stage },
  }]);
  const submission = await storage.getSubmission(run.submission_id);
  if (submission && (submission.status === "queued" || submission.status === "running")) {
    submission.status = "failed";
    await storage.putSubmission(submission);
  }
}

export async function executeDeterministicRun(
  run: Run,
  opts: { prompt: string; scenario: DeterministicScenario },
): Promise<{ sandbox_id: string }> {
  assertDeterministicLocalEnvironment();
  const secret = process.env.RUNNER_CALLBACK_SECRET;
  if (!secret) throw new Error("deterministic execution requires RUNNER_CALLBACK_SECRET");
  if (!DETERMINISTIC_SCENARIOS.includes(opts.scenario)) throw new Error(`unknown deterministic scenario: ${opts.scenario}`);

  const storage = getStorage();
  const sandboxId = `local-${run.id}`;
  const withSandbox = { ...(await storage.getRun(run.id) ?? run), sandbox_id: sandboxId };
  await storage.putRun(withSandbox);
  await storage.appendRunEvents(run.id, [{
    ts: deterministicTimestamp(run, 1), type: "run.sandbox_creating", payload: { sandbox_id: sandboxId, deterministic: true },
  }]);

  if (opts.scenario === "callback-failure") {
    const response = await callback(run.id, { events: [], status: "running" }, `${secret}-rejected`);
    if (response.status !== 401) throw new Error(`deterministic callback failure expected 401, received ${response.status}`);
    await markFailed(run, "deterministic callback authentication rejected", "callback", 2);
    return { sandbox_id: sandboxId };
  }

  if (opts.scenario === "stale-reap") {
    const { reapIfStale, reapThresholdMs } = await import("./reaper");
    const claimed = { ...withSandbox, dispatched_at: run.created_at };
    await storage.putRun(claimed);
    await reapIfStale(storage, claimed, Date.parse(deterministicTimestamp(run, 1)) + reapThresholdMs() + 1);
    return { sandbox_id: sandboxId };
  }

  await requireAccepted(await callback(run.id, {
    events: [{ ts: deterministicTimestamp(run, 2), type: "run.sandbox_ready", payload: { sandbox_id: sandboxId, deterministic: true } }],
    status: "running",
  }, secret), "ready callback");

  const tasks = buildRunnerTasks();
  const results: TaskResult[] = [];
  let offset = 3;
  for (const [index, task] of tasks.entries()) {
    const fails = opts.scenario === "task-failure" && index === 0;
    const result: TaskResult = {
      task_id: task.id,
      attempted: true,
      passed: !fails,
      reward: fails ? 0 : 1,
      cost_usd: 0,
      cost_source: "deterministic-fixture",
      duration_s: 0.25,
      agent_duration_s: 0.1,
      turns: 1,
      input_tokens: 16,
      output_tokens: 8,
      ...(fails ? { failure_stage: "agent", error: "deterministic task failure" } : {}),
    };
    results.push(result);
    const taskEvents: NewRunEvent[] = [
      { ts: deterministicTimestamp(run, offset++), type: "task.started", payload: { task_id: task.id, index } },
      { ts: deterministicTimestamp(run, offset++), type: "task.agent_finished", payload: { task_id: task.id, exit_code: fails ? 1 : 0 } },
      { ts: deterministicTimestamp(run, offset++), type: "task.verify_started", payload: { task_id: task.id } },
      fails
        ? { ts: deterministicTimestamp(run, offset++), type: "task.failed", payload: { task_id: task.id, stage: "agent", error: "deterministic task failure" } }
        : { ts: deterministicTimestamp(run, offset++), type: "task.verified", payload: { task_id: task.id, passed: true, reward: 1 } },
    ];
    await requireAccepted(await callback(run.id, { events: taskEvents, task_results: results }, secret), "task callback");
    const traceBody = `${JSON.stringify({ type: "session", id: `${run.id}:${task.id}`, deterministic: true })}\n`;
    const traceResponse = await requireAccepted(await trace(run.id, task.id, traceBody, secret), "trace callback");
    result.trace_blob_url = String(traceResponse.url);
    await requireAccepted(await callback(run.id, {
      events: [{ ts: deterministicTimestamp(run, offset++), type: "task.trace_uploaded", payload: { task_id: task.id, name: "session.jsonl" } }],
      task_results: results,
    }, secret), "trace event callback");
  }

  const overBudget = opts.scenario === "budget-exceeded";
  const virtualCost = overBudget ? 0.02 : 0;
  const terminalEvents: NewRunEvent[] = [
    ...(overBudget ? [{
      ts: deterministicTimestamp(run, offset++),
      type: "run.budget_exceeded" as const,
      payload: { spent_usd: virtualCost, cap_usd: 0.01, tasks_completed: tasks.length, deterministic: true },
    }] : []),
    { ts: deterministicTimestamp(run, offset), type: "run.completed", payload: { deterministic: true } },
  ];
  await requireAccepted(await callback(run.id, {
    events: terminalEvents,
    status: "completed",
    task_results: results,
    totals: {
      tasks_passed: results.filter((result) => result.passed).length,
      total_cost_usd: virtualCost,
      over_budget: overBudget,
    },
  }, secret), "terminal callback");
  return { sandbox_id: sandboxId };
}

export function deterministicScenarioFromMode(mode: string | undefined): DeterministicScenario | null {
  if (!mode?.startsWith("deterministic-")) return null;
  const scenario = mode.slice("deterministic-".length) as DeterministicScenario;
  if (!DETERMINISTIC_SCENARIOS.includes(scenario)) throw new Error(`unknown deterministic execution mode: ${mode}`);
  return scenario;
}
