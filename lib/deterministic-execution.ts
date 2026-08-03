import { NextRequest } from "next/server";
import {
  AGENT_TRACE_NAMES,
  buildRunCompletedEventPayload,
  buildTaskAgentFinishedEventPayload,
  buildTaskVerifiedEventPayload,
  computeTotals,
  VERIFIER_TRACE_NAME,
} from "../scripts/runner/lib.mjs";
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
  return new Date(Math.min((Number.isFinite(base) ? base : Date.now()) + offset, Date.now())).toISOString();
}

function localCallbackOrigin(): string {
  const port = Number(process.env.LOCAL_INSTANCE_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("deterministic execution requires a valid LOCAL_INSTANCE_PORT");
  }
  return `http://127.0.0.1:${port}`;
}

async function callback(runId: string, body: unknown, secret: string): Promise<Response> {
  const { POST } = await import("@/app/api/runs/[id]/callback/route");
  return POST(new NextRequest(`${localCallbackOrigin()}/api/runs/${runId}/callback`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-secret": secret },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: runId }) });
}

async function trace(runId: string, taskId: string, name: string, body: string, secret: string): Promise<Response> {
  const { POST } = await import("@/app/api/runs/[id]/trace/route");
  const query = new URLSearchParams({ task_id: taskId, name });
  return POST(new NextRequest(`${localCallbackOrigin()}/api/runs/${runId}/trace?${query}`, {
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
  const existingEvents = await storage.listRunEvents(run.id);
  const lastExistingTimestamp = existingEvents.at(-1)?.ts;
  const timelineRun = lastExistingTimestamp && Date.parse(lastExistingTimestamp) > Date.parse(run.created_at)
    ? { ...run, created_at: lastExistingTimestamp }
    : run;
  const sandboxId = `local-${run.id}`;
  const withSandbox = { ...(await storage.getRun(run.id) ?? run), sandbox_id: sandboxId };
  await storage.putRun(withSandbox);
  await storage.appendRunEvents(run.id, [{
    ts: deterministicTimestamp(timelineRun, 1), type: "run.sandbox_creating", payload: { sandbox_id: sandboxId, deterministic: true },
  }]);

  if (opts.scenario === "callback-failure") {
    const response = await callback(run.id, { events: [], status: "running" }, `${secret}-rejected`);
    if (response.status !== 401) throw new Error(`deterministic callback failure expected 401, received ${response.status}`);
    await markFailed(timelineRun, "deterministic callback authentication rejected", "callback", 2);
    return { sandbox_id: sandboxId };
  }

  if (opts.scenario === "stale-reap") {
    const { reapIfStale, reapThresholdMs } = await import("./reaper");
    const claimed = { ...withSandbox, dispatched_at: run.created_at };
    await storage.putRun(claimed);
    await reapIfStale(storage, claimed, Date.parse(deterministicTimestamp(timelineRun, 1)) + reapThresholdMs() + 1);
    return { sandbox_id: sandboxId };
  }

  await requireAccepted(await callback(run.id, {
    events: [{ ts: deterministicTimestamp(timelineRun, 2), type: "run.sandbox_ready", payload: { sandbox_id: sandboxId, deterministic: true } }],
    status: "running",
  }, secret), "ready callback");

  const tasks = buildRunnerTasks();
  const results: TaskResult[] = [];
  const agentDurationS = 0.1;
  const verifyDurationS = 0.15;
  let offset = 3;
  for (const [index, task] of tasks.entries()) {
    if (opts.scenario === "budget-exceeded" && index > 0) {
      results.push({ task_id: task.id, attempted: false, passed: false });
      continue;
    }
    const fails = opts.scenario === "task-failure" && index === 0;
    const result: TaskResult = {
      task_id: task.id,
      attempted: true,
      passed: !fails,
      reward: fails ? 0 : 1,
      cost_usd: opts.scenario === "budget-exceeded" ? 0.02 : 0,
      cost_source: "deterministic-fixture",
      duration_s: fails ? agentDurationS : agentDurationS + verifyDurationS,
      agent_duration_s: agentDurationS,
      turns: 1,
      input_tokens: 16,
      output_tokens: 8,
      ...(fails ? { failure_stage: "agent_process_error", error: "deterministic task failure" } : {}),
    };
    results.push(result);
    const taskEvents: NewRunEvent[] = [
      { ts: deterministicTimestamp(timelineRun, offset++), type: "task.started", payload: { task_id: task.id, index } },
      {
        ts: deterministicTimestamp(timelineRun, offset++),
        type: "task.agent_finished",
        payload: buildTaskAgentFinishedEventPayload({
          taskId: task.id,
          turns: result.turns,
          outputTokens: result.output_tokens,
          totalCost: result.cost_usd,
          costSource: result.cost_source,
          durationS: result.agent_duration_s,
        }),
      },
      ...(!fails ? [
        { ts: deterministicTimestamp(timelineRun, offset++), type: "task.verify_started" as const, payload: { task_id: task.id } },
        {
          ts: deterministicTimestamp(timelineRun, offset++),
          type: "task.verified" as const,
          payload: buildTaskVerifiedEventPayload({ taskId: task.id, passed: true, reward: 1, durationS: verifyDurationS }),
        },
      ] : []),
    ];
    await requireAccepted(await callback(run.id, { events: taskEvents, task_results: results }, secret), "task callback");
    const traceNames = fails ? AGENT_TRACE_NAMES : [...AGENT_TRACE_NAMES, VERIFIER_TRACE_NAME];
    for (const name of traceNames) {
      const traceBody = `${JSON.stringify({ type: "deterministic-trace", id: `${run.id}:${task.id}`, name })}\n`;
      const traceResponse = await requireAccepted(await trace(run.id, task.id, name, traceBody, secret), "trace callback");
      if (name === AGENT_TRACE_NAMES[0]) {
        const traceUrl = new URL(String(traceResponse.url));
        result.trace_blob_url = `${localCallbackOrigin()}${traceUrl.pathname}${traceUrl.search}`;
      }
      await requireAccepted(await callback(run.id, {
        events: [{ ts: deterministicTimestamp(timelineRun, offset++), type: "task.trace_uploaded", payload: { task_id: task.id, name } }],
        task_results: results,
      }, secret), "trace event callback");
    }
    if (fails) {
      await requireAccepted(await callback(run.id, {
        events: [{
          ts: deterministicTimestamp(timelineRun, offset++),
          type: "task.failed",
          payload: { task_id: task.id, stage: "agent_process_error", error: "deterministic task failure", duration_s: result.duration_s },
        }],
        task_results: results,
      }, secret), "task failure callback");
    }
  }

  const overBudget = opts.scenario === "budget-exceeded";
  const totals = computeTotals(results);
  const durationS = results.reduce((sum, result) => sum + (result.duration_s ?? 0), 0);
  const terminalEvents: NewRunEvent[] = [
    ...(overBudget ? [{
      ts: deterministicTimestamp(timelineRun, offset++),
      type: "run.budget_exceeded" as const,
      payload: { spent_usd: totals.total_cost_usd, cap_usd: 0.01, tasks_completed: 1, deterministic: true },
    }] : []),
    { ts: deterministicTimestamp(timelineRun, offset), type: "run.completed", payload: buildRunCompletedEventPayload(totals, durationS) },
  ];
  await requireAccepted(await callback(run.id, {
    events: terminalEvents,
    status: "completed",
    task_results: results,
    totals: {
      tasks_passed: totals.tasks_passed,
      total_cost_usd: totals.total_cost_usd,
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
