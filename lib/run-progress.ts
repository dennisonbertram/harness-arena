import type { RunEvent } from "./types";

// While a run is in flight, the run document's task_results / tasks_passed /
// total_cost are still empty — they're written all at once by the terminal
// callback when the run finishes. So mid-run the summary reads "—/0" even
// though tasks are completing. This reconstructs live progress from the event
// stream (which IS updated per task) so the page can show real progress
// instead of an empty shell.

export type TaskState = "running" | "verifying" | "passed" | "failed";

export interface TaskProgress {
  taskId: string;
  index: number;
  state: TaskState;
  turns?: number;
  costUsd?: number;
  durationS?: number;
  startedAtMs?: number;
  hasTrace: boolean;
  failureStage?: string;
  error?: string;
}

export interface RunProgress {
  tasks: TaskProgress[]; // in start order
  started: number;
  verified: number;
  passed: number;
  costSoFar: number | null; // sum of measured per-task costs (null if none measured)
  current: string | null; // task started but not yet verified
}

function payloadStr(p: Record<string, unknown>, k: string): string | undefined {
  return typeof p[k] === "string" ? (p[k] as string) : undefined;
}
function payloadNum(p: Record<string, unknown>, k: string): number | undefined {
  return typeof p[k] === "number" && Number.isFinite(p[k] as number) ? (p[k] as number) : undefined;
}

/** Rebuilds per-task progress from a run's events, in start order. */
export function reconstructRunProgress(events: RunEvent[]): RunProgress {
  const byTask = new Map<string, TaskProgress>();
  const order: string[] = [];

  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const taskId = payloadStr(p, "task_id");
    if (!taskId) continue;

    let t = byTask.get(taskId);
    if (!t) {
      t = { taskId, index: payloadNum(p, "index") ?? order.length, state: "running", hasTrace: false };
      byTask.set(taskId, t);
      order.push(taskId);
    }

    switch (e.type) {
      case "task.started":
        t.state = "running";
        if (Number.isFinite(Date.parse(e.ts))) t.startedAtMs = Date.parse(e.ts);
        if (payloadNum(p, "index") !== undefined) t.index = payloadNum(p, "index")!;
        break;
      case "task.agent_finished":
        t.state = "verifying";
        t.turns = payloadNum(p, "turns");
        t.costUsd = payloadNum(p, "cost_usd"); // absent = unmeasured
        t.durationS = payloadNum(p, "duration_s");
        break;
      case "task.verify_started":
        if (t.state === "running") t.state = "verifying";
        break;
      case "task.verified":
        t.state = p.passed === true ? "passed" : "failed";
        if (t.startedAtMs !== undefined && Number.isFinite(Date.parse(e.ts))) {
          const elapsedS = Math.max(0, (Date.parse(e.ts) - t.startedAtMs) / 1000);
          t.durationS = Math.max(t.durationS ?? 0, elapsedS);
        }
        break;
      case "task.failed":
        t.state = "failed";
        t.failureStage = payloadStr(p, "stage");
        t.error = payloadStr(p, "error");
        t.durationS = payloadNum(p, "duration_s") ?? t.durationS;
        break;
      case "task.trace_uploaded":
        t.hasTrace = true;
        break;
    }
  }

  const tasks = order.map((id) => byTask.get(id)!).sort((a, b) => a.index - b.index);
  const verifiedTasks = tasks.filter((t) => t.state === "passed" || t.state === "failed");
  const measured = tasks.map((t) => t.costUsd).filter((c): c is number => typeof c === "number");
  const current = tasks.find((t) => t.state === "running" || t.state === "verifying")?.taskId ?? null;

  return {
    tasks,
    started: tasks.length,
    verified: verifiedTasks.length,
    passed: verifiedTasks.filter((t) => t.state === "passed").length,
    costSoFar: measured.length > 0 ? measured.reduce((s, c) => s + c, 0) : null,
    current,
  };
}
