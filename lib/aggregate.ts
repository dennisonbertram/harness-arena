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
  meanTurns: number; // mean agent turns spent on this task (0 = never engaged)
  // Mean cost incurred attempting this task (pass or fail), null when unmeasured.
  // Only real spend counts: a task where the agent took 0 turns (nothing billed,
  // or the old fabricated floor) is treated as unmeasured, never a fake number.
  meanCostUsd: number | null;
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

    // Per-task pass rate, turns, AND cost across the group's runs — the
    // granular view that also applies to failing prompts (which tasks they do
    // solve, how hard they try, and what each costs whether it passes or not).
    const passed = new Map<string, number>();
    const of = new Map<string, number>();
    const turnsSum = new Map<string, number>();
    const costSum = new Map<string, number>();
    const costN = new Map<string, number>();
    for (const r of g.runs) {
      for (const t of r.task_results) {
        of.set(t.task_id, (of.get(t.task_id) ?? 0) + 1);
        if (t.passed) passed.set(t.task_id, (passed.get(t.task_id) ?? 0) + 1);
        const turns = t.turns ?? 0;
        turnsSum.set(t.task_id, (turnsSum.get(t.task_id) ?? 0) + turns);
        // Only count a cost that reflects real spend: turns > 0 with a numeric
        // cost. A 0-turn task billed nothing, so any stored figure there (incl.
        // the old fabricated $0.05 floor) is not a real measurement — exclude
        // it so meanCostUsd stays honest rather than inventing a number.
        if (typeof t.cost_usd === "number" && turns > 0) {
          costSum.set(t.task_id, (costSum.get(t.task_id) ?? 0) + t.cost_usd);
          costN.set(t.task_id, (costN.get(t.task_id) ?? 0) + 1);
        }
      }
    }
    const perTask: TaskRate[] = [...of.keys()]
      .map((taskId) => {
        const runsWith = of.get(taskId)!;
        const n = costN.get(taskId) ?? 0;
        return {
          taskId,
          passed: passed.get(taskId) ?? 0,
          of: runsWith,
          meanTurns: turnsSum.get(taskId)! / runsWith,
          meanCostUsd: n > 0 ? costSum.get(taskId)! / n : null,
        };
      })
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

export interface TaskAttempt {
  runId: string;
  agentName: string;
  isBaseline: boolean;
  passed: boolean;
  turns: number;
  costUsd: number | null; // null = unmeasured (turns 0 / no real cost record)
  submittedAt: string;
}

export interface TaskStats {
  taskId: string;
  attempts: number; // completed runs that recorded this task
  passed: number;
  passRate: number;
  meanTurns: number;
  meanCostUsd: number | null; // only real spend (turns > 0) counts, else null
  results: TaskAttempt[]; // most recent submission first
}

/**
 * Per-task view: every completed run's result for one task — pass/fail, turns,
 * and (honest) cost. Same rules as the standings: a task that ran 0 turns has
 * no real cost, so it's null (unmeasured), never a fabricated number. Returns
 * null if no completed run recorded the task.
 */
export function aggregateTask(runs: Run[], submissions: Submission[], taskId: string): TaskStats | null {
  const submissionById = new Map(submissions.map((s) => [s.id, s]));
  const results: TaskAttempt[] = [];
  for (const run of runs) {
    if (run.status !== "completed") continue;
    const tr = run.task_results.find((t) => t.task_id === taskId);
    if (!tr) continue;
    const submission = submissionById.get(run.submission_id);
    const turns = tr.turns ?? 0;
    results.push({
      runId: run.id,
      agentName: submission?.agent_name ?? "unknown",
      isBaseline: (submission?.prompt ?? "") === "",
      passed: tr.passed,
      turns,
      costUsd: typeof tr.cost_usd === "number" && turns > 0 ? tr.cost_usd : null,
      submittedAt: submission?.created_at ?? run.created_at,
    });
  }
  if (results.length === 0) return null;
  results.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));

  const attempts = results.length;
  const passed = results.filter((r) => r.passed).length;
  const measured = results.filter((r) => r.costUsd !== null) as (TaskAttempt & { costUsd: number })[];
  return {
    taskId,
    attempts,
    passed,
    passRate: passed / attempts,
    meanTurns: results.reduce((s, r) => s + r.turns, 0) / attempts,
    meanCostUsd: measured.length > 0 ? measured.reduce((s, r) => s + r.costUsd, 0) / measured.length : null,
    results,
  };
}
