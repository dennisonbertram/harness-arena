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
  // A task-level execution failure (for example, the model response timed
  // out). This is not a run infrastructure failure: the runner records a
  // failed task result and continues the benchmark.
  "task.failed",
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
  // Compact, non-secret provider-routing evidence captured by the local
  // Gateway proxy after each task. Persisting this makes provider failures,
  // response IDs, retry signals, and stream timing inspectable from the run
  // event history instead of only from ephemeral sandbox logs.
  "task.gateway_correlation",
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
  // Current run selected by single-run readers and the competition board.
  // A replay advances this pointer while run_ids retains the immutable history.
  run_id: z.string().optional(),
  // All runs spawned for this submission (RUNS_PER_SUBMISSION of them). Absent
  // for legacy single-run submissions.
  run_ids: z.array(z.string()).optional(),
  // The model this prompt runs on (gateway id). Absent = the default (glm-5.2)
  // for legacy submissions made before multi-model support.
  model: z.string().optional(),
  // Marks this submission as belonging to the /competition pool rather than
  // the main arena. Absent/false = main arena (the default, unaffected). Kept
  // (not repurposed) alongside competition_id: legacy rows predate the
  // Competition entity and only ever set this boolean, and slice 2 still
  // reads it as the fallback when competition_id is absent (issue #75/#76).
  competition: z.boolean().optional(),
  // Which Competition entity (see CompetitionSchema) this submission belongs
  // to. Absent on every row written before the backfill script ran (see
  // scripts/seed-competition.mjs) -- those rows are identified by
  // `competition: true` instead.
  competition_id: z.string().optional(),
  // Marks the one competition submission that is the reference baseline.
  competition_baseline: z.boolean().optional(),
  // Snapshot of the competition's requested AI Gateway provider. Keeping it
  // on the submission makes the routing target auditable even if the
  // Competition record is edited after this entry was queued.
  gateway_provider: z.string().optional(),
  // One immutable normalized-price table for every run on this board.
  pricing_version: z.string().min(1).optional(),
  // The submitter's GitHub identity, stamped server-side from the session —
  // never from the request body. Optional at the schema level because the
  // admin-triggered competition baseline has no submitting user; both
  // user-facing submission routes (main arena and competition) require a
  // session and always set these before storing.
  github_id: z.number().optional(),
  github_login: z.string().optional(),
  created_at: z.iso.datetime(),
});
export type Submission = z.infer<typeof SubmissionSchema>;

export const TaskResultSchema = z.object({
  task_id: z.string(),
  attempted: z.boolean(),
  passed: z.boolean(),
  reward: z.number().optional(),
  cost_usd: z.number().optional(),
  // Competition scoring cost from a fixed, versioned model price table.
  // This is deliberately separate from cost_usd, which is actual billed
  // spend and remains the budget/ledger signal.
  normalized_cost_usd: z.number().nonnegative().optional(),
  pricing_version: z.string().min(1).optional(),
  pricing_source: z.enum(["gateway-proxy", "gateway-generation-api"]).optional(),
  // How cost_usd was derived: "session" | "stdout" | "unmeasured". Absent
  // cost_usd with cost_source "unmeasured" means no cost record existed — we
  // report it as unknown rather than inventing a number.
  cost_source: z.string().optional(),
  duration_s: z.number().optional(),
  // Agent execution time excludes verifier work; together with output_tokens
  // it makes output-token throughput a meaningful model measurement.
  agent_duration_s: z.number().optional(),
  turns: z.number().optional(),
  // Sum of assistant output tokens for this task. Absent when the runner's
  // provider session did not report output usage.
  output_tokens: z.number().optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  cache_read_tokens: z.number().int().nonnegative().optional(),
  cache_write_tokens: z.number().int().nonnegative().optional(),
  trace_blob_url: z.string().optional(),
  failure_stage: z.string().optional(),
  error: z.string().optional(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

export const PRIZE_CADENCES = ["daily", "weekly", "monthly", "one-time"] as const;

// A (arena, harness, model, gateway provider) target -- one leaderboard, one
// prize pot (epic #74). "Harness Arena" is the one arena type that exists
// today, but arena is deliberately an open string rather than a closed enum: a
// future arena type (e.g. a bounty) is not a schema change, just a new value.
export const CompetitionSchema = z.object({
  id: z.string(),
  // Slug for the competition TYPE, e.g. "harness-arena". Open string on
  // purpose -- see comment above.
  arena: z.string(),
  harness: z.string(),
  // Gateway id, e.g. "zai/glm-5.2" -- must pass isAllowedModel (lib/models.ts).
  model: z.string(),
  // Provider slug supplied to AI Gateway's providerOptions.gateway.only.
  // Optional for legacy competitions, which continue to use the historical
  // model-level default in PINNED_PROVIDERS.
  gateway_provider: z.string().optional(),
  // Immutable normalized price table used to compare every row on this board.
  pricing_version: z.string().min(1).optional(),
  // Prize amount/cadence are data, not a constant, but deliberately UNSET at
  // seed time (epic #74: "TBD, do not invent a figure"). Nullable because a
  // seeded row explicitly carries "no value yet" rather than omitting the
  // field, so callers can distinguish "seeded, TBD" from "field doesn't
  // exist on this schema version."
  prize_amount_usd: z.number().nullable().optional(),
  prize_cadence: z.enum(PRIZE_CADENCES).nullable().optional(),
  // Closing is manual (epic #74) -- no scheduled rollover computes this.
  status: z.enum(["live", "closed"]),
  // Whether the reconciler may create a baseline for this competition.
  // Absent means yes: a competition without a baseline has no reference point.
  // Stored rather than inferred, because the board render and the cron sweep
  // reconcile independently of whoever created it and would otherwise
  // recreate the run an admin explicitly declined to pay for.
  auto_baseline: z.boolean().optional(),
  created_at: z.iso.datetime(),
  closed_at: z.iso.datetime().optional(),
});
export type Competition = z.infer<typeof CompetitionSchema>;

export const RunSchema = z.object({
  id: z.string(),
  submission_id: z.string(),
  status: z.enum(RUN_STATUSES),
  started_at: z.iso.datetime().optional(),
  finished_at: z.iso.datetime().optional(),
  tasks_passed: z.number().optional(),
  total_cost_usd: z.number().optional(),
  normalized_total_cost_usd: z.number().nonnegative().optional(),
  pricing_version: z.string().min(1).optional(),
  pricing_source: z.enum(["gateway-proxy", "gateway-generation-api"]).optional(),
  over_budget: z.boolean().optional(),
  sandbox_id: z.string().optional(),
  // When the dispatcher claimed this run and fired its sandbox. Set BEFORE the
  // sandbox call so concurrency accounting counts it as active and a second
  // dispatch is less likely to double-start it. Absent = not yet dispatched.
  dispatched_at: z.iso.datetime().optional(),
  // The model this run executed on (gateway id). Absent = default glm-5.2.
  // Which upstream provider the AI Gateway was pinned to for this run.
  //
  // The gateway fans one model id across many upstreams -- zai/glm-5.2 reports
  // fifteen -- which differ in quantisation and serving stack. Runs recorded
  // BEFORE pinning shipped have no value here, and are therefore not strictly
  // comparable with pinned ones: each sampled an unknown mix. Absence is the
  // deprecation marker; see isPrePinningRun and docs/provider-pinning.md.
  provider_pinned: z.string().optional(),
  // Provider this run was ASKED to pin. This is distinct from
  // provider_pinned, which is written only after the sidecar actually applies
  // the pin and therefore remains trustworthy as execution evidence.
  provider_requested: z.string().optional(),
  // What pi's system prompt actually resolved to inside the container, read
  // off the request body by the gateway sidecar. Absent on runs that predate
  // the capture, and on any run whose model never reached the sidecar.
  resolved_system_prompt: z.string().optional(),
  model: z.string().optional(),
  // Admin-authorized replay provenance. The source run remains immutable;
  // operation identity makes a lost-response retry reuse the same replay run.
  replay_of_run_id: z.string().optional(),
  replay_operation_id: z.uuid().optional(),
  // Replay reservations are invisible to the dispatcher until every source
  // submission has been repointed. Absent means ready for legacy runs.
  replay_ready: z.boolean().optional(),
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
