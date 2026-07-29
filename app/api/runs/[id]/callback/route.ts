import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { dispatchQueuedRuns } from "@/lib/dispatch";
import { log } from "@/lib/log";
import { verifyRunnerSecret } from "@/lib/runner-auth";
import { getStorage } from "@/lib/storage";
import { NewRunEventSchema, TaskResultSchema } from "@/lib/types";
import type { Run } from "@/lib/types";

const CallbackBodySchema = z
  .object({
    events: z.array(NewRunEventSchema),
    status: z.enum(["running", "completed", "failed"]).optional(),
    task_results: z.array(TaskResultSchema).optional(),
    // Which gateway upstream this run was pinned to. Absent means unpinned,
    // which is exactly how a pre-pinning run is identified.
    provider_pinned: z.string().optional(),
    // The system prompt pi actually sent, captured off the wire by the gateway
    // sidecar. A baseline's submitted prompt is empty by design ("run vanilla
    // pi"), so this is the only faithful record of what it really ran.
    resolved_system_prompt: z.string().optional(),
    totals: z
      .object({
        tasks_passed: z.number(),
        total_cost_usd: z.number(),
        over_budget: z.boolean(),
      })
      .optional(),
  })
  .refine((data) => data.status !== "completed" || (data.totals !== undefined && data.task_results !== undefined), {
    message: "totals and task_results are required when status is completed",
  });

// Terminal run states never transition; the only forward path is
// queued -> running -> completed|failed. Anything else (including a
// terminal-state regression) is logged and ignored, not applied.
const TERMINAL_RUN_STATUSES = new Set<Run["status"]>(["completed", "failed", "reaped"]);
// queued->completed/failed is belt-and-suspenders (issue #23 finding B):
// if the runner's early "running" post is lost, its own terminal post must
// still land instead of being rejected as an invalid transition.
const VALID_RUN_TRANSITIONS: Partial<Record<Run["status"], Run["status"][]>> = {
  queued: ["running", "completed", "failed"],
  running: ["completed", "failed"],
};

function canTransition(from: Run["status"], to: Run["status"]): boolean {
  if (from === to) return true;
  if (TERMINAL_RUN_STATUSES.has(from)) return false;
  return (VALID_RUN_TRANSITIONS[from] ?? []).includes(to);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!verifyRunnerSecret(request)) {
    return new NextResponse(null, { status: 401 });
  }

  const storage = getStorage();
  const run = await storage.getRun(id);
  if (!run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  const rawBody = await request.json().catch(() => null);
  const parsed = CallbackBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid callback body" }, { status: 400 });
  }

  const appended = await storage.appendRunEvents(id, parsed.data.events);

  // ponytail: read-modify-write on the run doc assumes the single sequential
  // runner is the only writer during a run (reaper only acts after
  // inactivity). CAS/locking when concurrent writers appear.
  let transitioned = false;
  if (parsed.data.status) {
    if (canTransition(run.status, parsed.data.status)) {
      run.status = parsed.data.status;
      transitioned = true;
    } else {
      log("warn", "callback.invalid_transition", { run_id: id, from: run.status, to: parsed.data.status });
    }
  }
  if (parsed.data.task_results) run.task_results = parsed.data.task_results;
  if (parsed.data.provider_pinned) run.provider_pinned = parsed.data.provider_pinned;
  if (parsed.data.resolved_system_prompt) run.resolved_system_prompt = parsed.data.resolved_system_prompt;
  if (parsed.data.totals) {
    run.tasks_passed = parsed.data.totals.tasks_passed;
    run.total_cost_usd = parsed.data.totals.total_cost_usd;
    run.over_budget = parsed.data.totals.over_budget;
  }
  if (transitioned && (run.status === "completed" || run.status === "failed")) {
    run.finished_at = new Date().toISOString();
  }
  // Only write the run doc when it actually changed. Events are persisted
  // separately (appendRunEvents), so an events-only callback must NOT rewrite
  // the run doc — under Blob read lag it would read a stale copy (e.g. still
  // "queued" moments after "running" was set) and revert the status. That
  // regression is exactly why runs displayed "queued" for their whole life.
  const runChanged = transitioned || parsed.data.task_results !== undefined || parsed.data.totals !== undefined;
  if (runChanged) {
    await storage.putRun(run);
  }

  if (transitioned) {
    const submission = await storage.getSubmission(run.submission_id);
    if (submission) {
      if (run.status === "running") submission.status = "running";
      else if (run.status === "completed") submission.status = "scored";
      else if (run.status === "failed") submission.status = "failed";
      await storage.putSubmission(submission);
    }
  }

  // When a run reaches a terminal state it frees a concurrency slot, so kick the
  // dispatcher to backfill it with the next queued run. This is the reliable
  // drainer: a submission's runs step through the cap as earlier ones finish,
  // without depending on someone polling the UI.
  if (transitioned && (run.status === "completed" || run.status === "failed")) {
    const storageRef = storage;
    const kick = () =>
      dispatchQueuedRuns(storageRef).catch((err: unknown) =>
        log("warn", "dispatch.failed", { run_id: id, error: (err as Error).message }),
      );
    try {
      after(kick);
    } catch {
      void kick();
    }
  }

  log("info", "callback.received", {
    run_id: id,
    event_count: parsed.data.events.length,
    status: parsed.data.status,
  });

  return NextResponse.json({ ok: true, seq_assigned: appended.map((e) => e.seq) });
}
