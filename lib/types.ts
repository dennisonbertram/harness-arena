import { z } from "zod";

export const SUBMISSION_STATUSES = [
  "pending_review",
  "rejected",
  "queued",
  "running",
  "scored",
  // "failed": run infrastructure failed after queueing — contract addition over ticket #4, recorded in PR #13
  "failed",
] as const;

export const RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "reaped",
] as const;

// Exhaustive run_events taxonomy — see docs/decisions (or the ticket #4 task
// contract) for the authoritative list. Every type here maps 1:1 to a
// lifecycle transition or per-task event the runner emits.
export const RUN_EVENT_TYPES = [
  "run.created",
  "run.sandbox_creating",
  "run.sandbox_ready",
  "task.started",
  "task.agent_finished",
  "task.verify_started",
  "task.verified",
  "task.trace_uploaded",
  "run.budget_exceeded",
  "run.completed",
  "run.failed",
  "run.reaped",
  // Emitted by runner.mjs (issue #19/#24) whenever a task's cost can't be
  // trusted from the session file (unreadable, no assistant cost record,
  // or a negative cost.total) and a floor/clamp was applied. Missing from
  // this enum meant the callback route's zod validation 400'd the whole
  // batch -- including the run's status -- whenever the runner emitted it
  // (issue #23 finding A).
  "task.cost_tamper_signal",
] as const;

export const SubmissionSchema = z.object({
  id: z.string(),
  agent_name: z.string(),
  prompt: z.string(),
  status: z.enum(SUBMISSION_STATUSES),
  judge_verdict: z.string().optional(),
  judge_reason: z.string().optional(),
  judge_model: z.string().optional(),
  judged_at: z.iso.datetime().optional(),
  // First of the submission's runs, kept for backward-compatible readers.
  run_id: z.string().optional(),
  // All runs spawned for this submission (RUNS_PER_SUBMISSION of them). Absent
  // for legacy single-run submissions.
  run_ids: z.array(z.string()).optional(),
  // The model this prompt runs on (gateway id). Absent = the default (glm-5.2)
  // for legacy submissions made before multi-model support.
  model: z.string().optional(),
  created_at: z.iso.datetime(),
});
export type Submission = z.infer<typeof SubmissionSchema>;

export const TaskResultSchema = z.object({
  task_id: z.string(),
  attempted: z.boolean(),
  passed: z.boolean(),
  reward: z.number().optional(),
  cost_usd: z.number().optional(),
  // How cost_usd was derived: "session" | "stdout" | "unmeasured". Absent
  // cost_usd with cost_source "unmeasured" means no cost record existed — we
  // report it as unknown rather than inventing a number.
  cost_source: z.string().optional(),
  duration_s: z.number().optional(),
  turns: z.number().optional(),
  trace_blob_url: z.string().optional(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

export const RunSchema = z.object({
  id: z.string(),
  submission_id: z.string(),
  status: z.enum(RUN_STATUSES),
  started_at: z.iso.datetime().optional(),
  finished_at: z.iso.datetime().optional(),
  tasks_passed: z.number().optional(),
  total_cost_usd: z.number().optional(),
  over_budget: z.boolean().optional(),
  sandbox_id: z.string().optional(),
  // When the dispatcher claimed this run and fired its sandbox. Set BEFORE the
  // sandbox call so concurrency accounting counts it as active and a second
  // dispatch is less likely to double-start it. Absent = not yet dispatched.
  dispatched_at: z.iso.datetime().optional(),
  // The model this run executed on (gateway id). Absent = default glm-5.2.
  model: z.string().optional(),
  task_results: z.array(TaskResultSchema),
  created_at: z.iso.datetime(),
});
export type Run = z.infer<typeof RunSchema>;

export const RunEventSchema = z.object({
  run_id: z.string(),
  seq: z.number().int().positive(),
  ts: z.iso.datetime(),
  type: z.enum(RUN_EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

// Shape a caller supplies to appendRunEvents — run_id and seq are assigned
// by storage, not the caller.
export const NewRunEventSchema = RunEventSchema.omit({ run_id: true, seq: true });
export type NewRunEvent = z.infer<typeof NewRunEventSchema>;
