import type { Run, Submission } from "./types";

// v1 benchmarks PASS RATE, not cost. With glm-5.2's run-to-run variance
// (the same vanilla prompt scored 7,7,5,4 of 16 across identical runs) a
// single run's pass/fail is close to noise — so a prompt is scored by its
// MEAN pass rate across every run it has, which is exactly what averages the
// variance out. Cost is tracked but secondary: it only becomes meaningful
// once a prompt reliably solves a task, so it's the tiebreak / next frontier,
// not the primary axis yet.
//
// Runs are grouped by prompt (the artifact being benchmarked) — resubmitting
// the same prompt just adds samples and tightens its rate estimate.

export interface TaskRate {
  taskId: string;
  passed: number; // runs in which this task passed
  of: number; // runs in which this task was recorded
}

export interface PromptStanding {
  promptKey: string;
  agentName: string;
  runIds: string[];
  runs: number; // completed runs aggregated
  meanTasksPassed: number;
  totalTaskCount: number;
  passRate: number; // meanTasksPassed / totalTaskCount — PRIMARY, higher wins
  perTask: TaskRate[]; // sorted by rate desc, then taskId
  medianCostUsd: number | null; // across the runs — secondary tiebreak
  completesTest: boolean; // passRate === 1: every task passed in every run
  lastSubmittedAt: string;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Groups completed runs by their submission's prompt and computes each
 * prompt's mean pass rate, per-task pass rate, and median cost. Only
 * `completed` runs with a numeric tasks_passed are counted — a crashed or
 * reaped run isn't a valid sample. Returns standings sorted by pass rate
 * descending, then median cost ascending (cheaper breaks a rate tie), then
 * more runs (more evidence) first.
 */
export function aggregatePrompts(
  runs: Run[],
  submissions: Submission[],
  totalTaskCount: number,
): PromptStanding[] {
  const submissionById = new Map(submissions.map((s) => [s.id, s]));

  // Group completed runs by prompt text.
  const groups = new Map<string, { runs: Run[]; agentName: string; lastAt: string }>();
  for (const run of runs) {
    if (run.status !== "completed" || run.tasks_passed === undefined) continue;
    const submission = submissionById.get(run.submission_id);
    const promptKey = submission?.prompt ?? `__unknown:${run.submission_id}`;
    const at = submission?.created_at ?? run.created_at;
    const g = groups.get(promptKey);
    if (g) {
      g.runs.push(run);
      if (at > g.lastAt) {
        g.lastAt = at;
        g.agentName = submission?.agent_name ?? g.agentName;
      }
    } else {
      groups.set(promptKey, { runs: [run], agentName: submission?.agent_name ?? "unknown", lastAt: at });
    }
  }

  const standings: PromptStanding[] = [];
  for (const [promptKey, g] of groups) {
    const runsCount = g.runs.length;
    const meanTasksPassed = g.runs.reduce((sum, r) => sum + (r.tasks_passed ?? 0), 0) / runsCount;

    // Per-task pass rate across the group's runs.
    const passed = new Map<string, number>();
    const of = new Map<string, number>();
    for (const r of g.runs) {
      for (const t of r.task_results) {
        of.set(t.task_id, (of.get(t.task_id) ?? 0) + 1);
        if (t.passed) passed.set(t.task_id, (passed.get(t.task_id) ?? 0) + 1);
      }
    }
    const perTask: TaskRate[] = [...of.keys()]
      .map((taskId) => ({ taskId, passed: passed.get(taskId) ?? 0, of: of.get(taskId)! }))
      .sort((a, b) => b.passed / b.of - a.passed / a.of || a.taskId.localeCompare(b.taskId));

    const costs = g.runs.map((r) => r.total_cost_usd).filter((c): c is number => typeof c === "number");
    const passRate = totalTaskCount > 0 ? meanTasksPassed / totalTaskCount : 0;

    standings.push({
      promptKey,
      agentName: g.agentName,
      runIds: g.runs.map((r) => r.id),
      runs: runsCount,
      meanTasksPassed,
      totalTaskCount,
      passRate,
      perTask,
      medianCostUsd: median(costs),
      completesTest: passRate === 1,
      lastSubmittedAt: g.lastAt,
    });
  }

  return standings.sort(
    (a, b) =>
      b.passRate - a.passRate ||
      (a.medianCostUsd ?? Infinity) - (b.medianCostUsd ?? Infinity) ||
      b.runs - a.runs,
  );
}
