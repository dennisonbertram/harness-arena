import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { log } from "@/lib/log";
import { getStorage } from "@/lib/storage";
import { NewRunEventSchema, TaskResultSchema } from "@/lib/types";

const CallbackBodySchema = z.object({
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
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (request.headers.get("x-runner-secret") !== process.env.RUNNER_CALLBACK_SECRET) {
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

  if (parsed.data.status) run.status = parsed.data.status;
  if (parsed.data.task_results) run.task_results = parsed.data.task_results;
  if (parsed.data.totals) {
    run.tasks_passed = parsed.data.totals.tasks_passed;
    run.total_cost_usd = parsed.data.totals.total_cost_usd;
    run.over_budget = parsed.data.totals.over_budget;
  }
  if (parsed.data.status === "completed" || parsed.data.status === "failed") {
    run.finished_at = new Date().toISOString();
  }
  await storage.putRun(run);

  log("info", "callback.received", {
    run_id: id,
    event_count: parsed.data.events.length,
    status: parsed.data.status,
  });

  return NextResponse.json({ ok: true, seq_assigned: appended.map((e) => e.seq) });
}
