import { modelLabel, runModel } from "./models";
import type { Run, Submission } from "./types";
import { UNKNOWN_GITHUB_LOGIN } from "./github";
import { isBaselinePrompt } from "./prompt";
import { isPrePinningRun } from "./arena-params";

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
  model: string; // gateway id the runs executed on (a standing is one prompt × one model)
  agentName: string;
  // The submitter's GitHub login (already-public GitHub data), from the most
  // recent submission of this prompt — same fallback-to-"unknown" convention
  // as agentName for pre-login submissions that never got stamped.
  githubLogin: string;
  runIds: string[];
  runs: number; // completed runs aggregated
  meanTasksPassed: number;
  /**
   * Standard error of meanTasksPassed across this standing's runs — how
   * precise the estimate is, not how spread the runs are. null for a single
   * run, where there is no measurable spread: reporting 0 would claim a
   * certainty one sample cannot support. Production sd is ~0.78 tasks, so
   * adjacent standings are often not distinguishable
   * (docs/measurement-and-variance.md).
   */
  tasksPassedSem: number | null;
  /**
   * How many of this standing's runs predate provider pinning. Those sampled
   * an unknown mix of gateway upstreams, so they are not strictly comparable
   * with pinned runs -- a standing mixing both is averaging across a change in
   * what was being measured. See docs/provider-pinning.md.
   */
  prePinningRuns: number;
  /**
   * The gateway upstream every run in this standing was pinned to, or
   * undefined when they were unpinned. Part of the grouping key: a pinned and
   * an unpinned run of the same prompt on the same model are not the same
   * measurement, so averaging them would hide the very comparison pinning
   * exists to make. See docs/provider-pinning.md.
   */
  pinnedProvider: string | undefined;
  totalTaskCount: number;
  passRate: number; // meanTasksPassed / totalTaskCount — PRIMARY, higher wins
  perTask: TaskRate[]; // sorted by rate desc, then taskId
  medianCostUsd: number | null; // across the runs — secondary tiebreak
  completesTest: boolean; // passRate === 1: every task passed in every run
  lastSubmittedAt: string;
}

// The benchmarks board's empty-prompt ("run vanilla pi with its built-in default
// system prompt") standings display as "<model> Baseline" -- a stray "p2" or
// "restore-check" name from a manual baseline run is not meaningful to show,
// and the submitter has no attached GitHub identity to show instead.
export function baselineDisplayName(standing: Pick<PromptStanding, "model" | "pinnedProvider">): string {
  const base = `${modelLabel(standing.model)} Baseline`;
  // Distinct label so a pinned baseline sits beside the unpinned one on the
  // board and can be compared, rather than silently replacing it.
  return standing.pinnedProvider ? `${base} (pinned: ${standing.pinnedProvider})` : base;
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

  // Group completed runs by (model, prompt): the same prompt on glm-5.2 vs
  // Claude is a different benchmark and must not be averaged together.
  const groups = new Map<
    string,
    {
      promptKey: string;
      model: string;
      pinnedProvider: string | undefined;
      runs: Run[];
      agentName: string;
      githubLogin: string;
      lastAt: string;
    }
  >();
  for (const run of runs) {
    if (run.status !== "completed" || run.tasks_passed === undefined) continue;
    const submission = submissionById.get(run.submission_id);
    // Competition entries (see the / homepage) live in the same storage but must
    // never surface on the main arena leaderboard or get averaged into a
    // main-arena standing that happens to share the same (model, prompt) key.
    if (submission?.competition) continue;
    // Whitespace-only prompts run baseline too (matches the submission
    // route's isBaselinePrompt check) and must group under the same "" key
    // as an actually-empty prompt, or they'd split into a duplicate standing.
    const promptKey =
      submission === undefined
        ? `__unknown:${run.submission_id}`
        : isBaselinePrompt(submission.prompt)
          ? ""
          : submission.prompt;
    const model = runModel(run.model ?? submission?.model);
    // Pinning is part of the identity of a measurement, not a property of it.
    const pinnedProvider = run.provider_pinned;
    const key = `${model}\0${promptKey}\0${pinnedProvider ?? ""}`;
    const at = submission?.created_at ?? run.created_at;
    const g = groups.get(key);
    if (g) {
      g.runs.push(run);
      if (at > g.lastAt) {
        g.lastAt = at;
        g.agentName = submission?.agent_name ?? g.agentName;
        g.githubLogin = submission?.github_login ?? g.githubLogin;
      }
    } else {
      groups.set(key, {
        promptKey,
        model,
        pinnedProvider,
        runs: [run],
        agentName: submission?.agent_name ?? "unknown",
        githubLogin: submission?.github_login ?? UNKNOWN_GITHUB_LOGIN,
        lastAt: at,
      });
    }
  }

  const standings: PromptStanding[] = [];
  for (const g of groups.values()) {
    const promptKey = g.promptKey;
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

    const prePinningRuns = g.runs.filter((r) => isPrePinningRun(r)).length;
    const passedPerRun = g.runs.map((r) => r.tasks_passed ?? 0);
    const tasksPassedSem =
      passedPerRun.length < 2
        ? null
        : Math.sqrt(
            passedPerRun.reduce((sum, v) => sum + (v - meanTasksPassed) ** 2, 0) / (passedPerRun.length - 1),
          ) / Math.sqrt(passedPerRun.length);

    const costs = g.runs.map((r) => r.total_cost_usd).filter((c): c is number => typeof c === "number");
    const passRate = totalTaskCount > 0 ? meanTasksPassed / totalTaskCount : 0;

    standings.push({
      promptKey,
      model: g.model,
      agentName: g.agentName,
      githubLogin: g.githubLogin,
      runIds: g.runs.map((r) => r.id),
      runs: runsCount,
      meanTasksPassed,
      tasksPassedSem,
      prePinningRuns,
      pinnedProvider: g.pinnedProvider,
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

/**
 * /benchmarks task-difficulty overview, broken out PER MODEL so glm-5.2 and Claude
 * are never averaged into one misleading number. For each task, groups every
 * completed run's attempt by the model it ran on. Tasks with no completed run
 * are omitted; sorted by overall pass rate desc (task difficulty), then taskId.
 */
export function aggregateAllRunsByTask(
  runs: Run[],
  submissions: Submission[],
  taskIds: string[],
): TaskModelBreakdown[] {
  return taskIds
    .map((taskId) => {
      const attempts = taskAttempts(runs, submissions, taskId);
      if (attempts.length === 0) return null;
      const passed = attempts.filter((a) => a.passed).length;
      return { taskId, passed, of: attempts.length, perModel: summariesByModel(attempts) };
    })
    .filter((b): b is TaskModelBreakdown => b !== null)
    .sort((a, b) => b.passed / b.of - a.passed / a.of || a.taskId.localeCompare(b.taskId));
}

export interface TaskAttempt {
  runId: string;
  agentName: string;
  isBaseline: boolean;
  model: string; // gateway id this attempt ran on (never mix models silently)
  passed: boolean;
  turns: number;
  agentDurationS: number | null;
  outputTokens: number | null;
  // Runner-reported elapsed wall-clock duration. Older attempts did not
  // persist it, so null means unavailable rather than a zero-second run.
  durationS: number | null;
  costUsd: number | null; // null = unmeasured (turns 0 / no real cost record)
  submittedAt: string;
}

/** Per-model summary of a task's attempts (never a cross-model average). */
export interface TaskModelSummary {
  model: string;
  attempts: number;
  passed: number;
  passRate: number;
  meanTurns: number;
  // Mean only across attempts that recorded a duration. null preserves the
  // distinction between no measurement and a very fast measured attempt.
  meanDurationS: number | null;
  // Weighted output throughput: all measured output tokens divided by all
  // measured agent-execution seconds, never by verifier-inclusive wall time.
  outputTokensPerSecond: number | null;
  meanCostUsd: number | null;
}

export interface TaskStats {
  taskId: string;
  attempts: number; // across all models (for a headline count only)
  passed: number;
  byModel: TaskModelSummary[]; // the real per-model breakdown, rate desc
  results: TaskAttempt[]; // every attempt, newest first, each stamped with model
}

/** A task's per-model breakdown for the /benchmarks overview. */
export interface TaskModelBreakdown {
  taskId: string;
  passed: number; // total across models (task-difficulty sort)
  of: number;
  perModel: TaskModelSummary[];
}

/** Every completed run's result for one task, each stamped with its model, newest first. */
function taskAttempts(runs: Run[], submissions: Submission[], taskId: string): TaskAttempt[] {
  const submissionById = new Map(submissions.map((s) => [s.id, s]));
  const results: TaskAttempt[] = [];
  for (const run of runs) {
    if (run.status !== "completed") continue;
    const submission = submissionById.get(run.submission_id);
    // Same competition exclusion as aggregatePrompts above — this feeds the
    // /benchmarks per-task panel (aggregateAllRunsByTask) and the task detail
    // page (aggregateTask), both of which must stay main-arena-only too.
    if (submission?.competition) continue;
    const tr = run.task_results.find((t) => t.task_id === taskId);
    if (!tr) continue;
    const turns = tr.turns ?? 0;
    results.push({
      runId: run.id,
      agentName: submission?.agent_name ?? "unknown",
      isBaseline: (submission?.prompt ?? "") === "",
      model: runModel(run.model ?? submission?.model),
      passed: tr.passed,
      turns,
      agentDurationS: typeof tr.agent_duration_s === "number" ? tr.agent_duration_s : null,
      outputTokens: typeof tr.output_tokens === "number" ? tr.output_tokens : null,
      durationS: typeof tr.duration_s === "number" ? tr.duration_s : null,
      costUsd: typeof tr.cost_usd === "number" && turns > 0 ? tr.cost_usd : null,
      submittedAt: submission?.created_at ?? run.created_at,
    });
  }
  results.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
  return results;
}

/** Groups attempts by model into per-model summaries, pass rate descending. */
function summariesByModel(attempts: TaskAttempt[]): TaskModelSummary[] {
  const groups = new Map<string, TaskAttempt[]>();
  for (const a of attempts) {
    const g = groups.get(a.model);
    if (g) g.push(a);
    else groups.set(a.model, [a]);
  }
  return [...groups.entries()]
    .map(([model, atts]) => {
      const n = atts.length;
      const passed = atts.filter((a) => a.passed).length;
      const measured = atts.filter((a) => a.costUsd !== null) as (TaskAttempt & { costUsd: number })[];
      const durationMeasured = atts.filter((a) => a.durationS !== null) as (TaskAttempt & { durationS: number })[];
      const throughputMeasured = atts.filter(
        (a): a is TaskAttempt & { agentDurationS: number; outputTokens: number } =>
          a.agentDurationS !== null && a.agentDurationS > 0 && a.outputTokens !== null,
      );
      const measuredAgentSeconds = throughputMeasured.reduce((sum, a) => sum + a.agentDurationS, 0);
      return {
        model,
        attempts: n,
        passed,
        passRate: passed / n,
        meanTurns: atts.reduce((s, a) => s + a.turns, 0) / n,
        meanDurationS: durationMeasured.length > 0
          ? durationMeasured.reduce((s, a) => s + a.durationS, 0) / durationMeasured.length
          : null,
        outputTokensPerSecond: measuredAgentSeconds > 0
          ? throughputMeasured.reduce((sum, a) => sum + a.outputTokens, 0) / measuredAgentSeconds
          : null,
        meanCostUsd: measured.length > 0 ? measured.reduce((s, a) => s + a.costUsd, 0) / measured.length : null,
      };
    })
    .sort((x, y) => y.passRate - x.passRate || x.model.localeCompare(y.model));
}

/**
 * Per-task view for the task page: every completed run's result for one task,
 * split by model so the page never shows a cross-model average. Returns null if
 * no completed run recorded the task.
 */
export function aggregateTask(runs: Run[], submissions: Submission[], taskId: string): TaskStats | null {
  const results = taskAttempts(runs, submissions, taskId);
  if (results.length === 0) return null;
  return {
    taskId,
    attempts: results.length,
    passed: results.filter((r) => r.passed).length,
    byModel: summariesByModel(results),
    results,
  };
}
