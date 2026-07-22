import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
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
const VALID_RUN_TRANSITIONS: Partial<Record<Run["status"], Run["status"][]>> = {
  queued: ["running"],
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
  if (parsed.data.totals) {
    run.tasks_passed = parsed.data.totals.tasks_passed;
    run.total_cost_usd = parsed.data.totals.total_cost_usd;
    run.over_budget = parsed.data.totals.over_budget;
  }
  if (transitioned && (run.status === "completed" || run.status === "failed")) {
    run.finished_at = new Date().toISOString();
  }
  await storage.putRun(run);

  if (transitioned) {
    const submission = await storage.getSubmission(run.submission_id);
    if (submission) {
      if (run.status === "running") submission.status = "running";
      else if (run.status === "completed") submission.status = "scored";
      else if (run.status === "failed") submission.status = "failed";
      await storage.putSubmission(submission);
    }
  }

  log("info", "callback.received", {
    run_id: id,
    event_count: parsed.data.events.length,
    status: parsed.data.status,
  });

  return NextResponse.json({ ok: true, seq_assigned: appended.map((e) => e.seq) });
}
