import { randomUUID, timingSafeEqual } from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { competitionAdminToken } from "@/lib/competition-config";
import { dispatchQueuedRuns } from "@/lib/dispatch";
import { log, normalizeError } from "@/lib/log";
import { DEFAULT_MODEL, isAllowedModel } from "@/lib/models";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";
import type { Run, Submission } from "@/lib/types";

// Mirrors app/api/submissions/route.ts's own constant -- the main-arena
// baseline needs the same sample size as a normal submission.
const RUNS_PER_SUBMISSION = Math.max(1, Math.floor(Number(process.env.RUNS_PER_SUBMISSION ?? 5)) || 5);

const BASELINE_AGENT_NAME = "pi-vanilla-baseline";

// Same POC-level limiter shape as the other admin/submission endpoints --
// throttles repeated admin-token-guessing attempts, not just legitimate use.
const isRateLimited = createRateLimiter(5);

function isValidToken(token: string | null, expected: string): boolean {
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const BodySchema = z.object({
  model: z.string().optional(),
});

/**
 * Admin-triggered main-arena baseline: creates an empty-prompt ("vanilla pi,
 * no --system-prompt") submission with no submitting GitHub user -- the same
 * has-no-submitter shape the Submission schema already documents for the
 * competition's admin baseline, and matches the site's own convention that
 * baselines are run manually rather than through a signed-in user's submit
 * flow.
 */
export async function POST(request: NextRequest) {
  const expected = competitionAdminToken();
  if (!expected) {
    return NextResponse.json({ error: "COMPETITION_ADMIN_TOKEN is not configured on the server" }, { status: 500 });
  }

  const ip = clientIp(request);
  if (isRateLimited(ip)) {
    log("warn", "admin.baseline.rate_limited", { ip });
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }

  const token = request.headers.get("x-competition-admin-token");
  if (!isValidToken(token, expected)) {
    return NextResponse.json({ error: "invalid or missing admin token" }, { status: 401 });
  }

  const rawBody = await request.json().catch(() => ({}));
  const parsedInput = BodySchema.safeParse(rawBody);
  if (!parsedInput.success) {
    return NextResponse.json({ error: "invalid body", details: parsedInput.error.issues }, { status: 400 });
  }

  const model = parsedInput.data.model ?? DEFAULT_MODEL;
  if (!isAllowedModel(model)) {
    return NextResponse.json({ error: `model "${model}" is not allowed` }, { status: 400 });
  }

  const storage = getStorage();
  const now = new Date().toISOString();
  const submission: Submission = {
    id: randomUUID(),
    agent_name: BASELINE_AGENT_NAME,
    prompt: "",
    // Vanilla baseline: nothing to judge for fraud, matches the normal
    // submit route's own isBaselinePrompt("") short-circuit.
    status: "queued",
    judge_verdict: "approved",
    judge_reason: "vanilla baseline (no custom system prompt)",
    judged_at: now,
    model,
    created_at: now,
  };
  await storage.putSubmission(submission);

  const runs: Run[] = Array.from({ length: RUNS_PER_SUBMISSION }, () => ({
    id: randomUUID(),
    submission_id: submission.id,
    status: "queued" as const,
    model,
    task_results: [],
    created_at: now,
  }));
  for (const run of runs) {
    await storage.putRun(run);
    await storage.appendRunEvents(run.id, [
      { ts: new Date().toISOString(), type: "run.created", payload: { submission_id: submission.id } },
    ]);
  }
  const runIds = runs.map((r) => r.id);
  submission.run_id = runIds[0];
  submission.run_ids = runIds;
  await storage.putSubmission(submission);

  const kickDispatch = () =>
    dispatchQueuedRuns(storage).catch((err: unknown) =>
      log("error", "dispatch.failed", { submission_id: submission.id, ...normalizeError(err, "dispatch") }),
    );
  try {
    after(kickDispatch);
  } catch {
    void kickDispatch();
  }

  return NextResponse.json({ submission_id: submission.id, run_ids: runIds, status: submission.status });
}
