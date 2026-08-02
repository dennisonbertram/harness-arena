import { randomUUID } from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveIdentity } from "@/lib/identity";
import { JUDGE_MODEL, judgeSubmission } from "@/lib/judge";
import { log, normalizeError } from "@/lib/log";
import { dispatchQueuedRuns } from "@/lib/dispatch";
import { DEFAULT_MODEL, isAllowedModel } from "@/lib/models";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { isBaselinePrompt } from "@/lib/prompt";
import { getStorage } from "@/lib/storage";
import { getTasks } from "@/lib/tasks";
import type { Run, Submission } from "@/lib/types";

const MAX_PROMPT_CHARS = 32768;
const MAX_BODY_BYTES = 262144;

// Fixed sample size per submission: each approved (prompt, model) runs this many
// times so pass rate is a mean over a uniform n, not a single noisy run. The
// runs are created queued and started by the dispatcher under a global
// concurrency cap (lib/dispatch.ts) — NOT spawned inline, which is what
// overwhelmed the serverless budget when several submissions landed at once.
// Override via RUNS_PER_SUBMISSION; floored at 1.
const RUNS_PER_SUBMISSION = Math.max(1, Math.floor(Number(process.env.RUNS_PER_SUBMISSION ?? 5)) || 5);

const SubmissionInputSchema = z.object({
  agent_name: z.string().min(1).max(40),
  // Empty prompt is allowed and means "run vanilla pi with its built-in
  // default system prompt" (the baseline) -- matches harnessarena.xyz's
  // baseline, which passes no --system-prompt. Non-empty prompts go through
  // the fraud judge as usual.
  prompt: z.string().max(MAX_PROMPT_CHARS),
  // Optional model (gateway id); defaults to glm-5.2. Must be on the allowlist
  // so a public submitter can't route to an arbitrary/expensive model.
  model: z.string().optional(),
});

// A GitHub account is cheap to mint, so identity alone is a weak rate-limit
// key — both buckets must admit the request (R3). Shares the naive
// in-memory limiter with the competition submissions route (see
// lib/rate-limit.ts for the POC-level caveat).
const isIpRateLimited = createRateLimiter(5);
const isGithubIdRateLimited = createRateLimiter(5);

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json({ error: "content-type must be application/json" }, { status: 415 });
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "request body too large" }, { status: 413 });
  }

  // IP-based check runs before auth() (matches the competition route's
  // ordering) so a flood of malformed/oversized/unauthenticated requests is
  // rejected via a cheap in-memory lookup before paying for a session decrypt.
  const ip = clientIp(request);
  if (isIpRateLimited(ip)) {
    log("warn", "submission.rate_limited", { ip });
    return NextResponse.json({ error: "rate limit exceeded, max 5 submissions per hour" }, { status: 429 });
  }

  const identity = await resolveIdentity(request);
  if (!identity) {
    return NextResponse.json({ error: "sign in with GitHub to submit" }, { status: 401 });
  }
  const { githubId, githubLogin } = identity;

  if (isGithubIdRateLimited(String(githubId))) {
    log("warn", "submission.rate_limited", { ip, github_id: githubId });
    return NextResponse.json({ error: "rate limit exceeded, max 5 submissions per hour" }, { status: 429 });
  }

  const rawBody = await request.json().catch(() => null);
  const parsedInput = SubmissionInputSchema.safeParse(rawBody);
  if (!parsedInput.success) {
    return NextResponse.json(
      { error: "invalid submission", details: parsedInput.error.issues },
      { status: 400 },
    );
  }

  const model = parsedInput.data.model ?? DEFAULT_MODEL;
  if (!isAllowedModel(model)) {
    return NextResponse.json({ error: `model "${model}" is not allowed` }, { status: 400 });
  }

  const storage = getStorage();
  const submission: Submission = {
    id: randomUUID(),
    agent_name: parsedInput.data.agent_name,
    prompt: parsedInput.data.prompt,
    status: "pending_review",
    model,
    github_id: githubId,
    github_login: githubLogin,
    created_at: new Date().toISOString(),
  };
  await storage.putSubmission(submission);

  let verdict;
  if (isBaselinePrompt(submission.prompt)) {
    // Vanilla baseline: no submitted prompt, nothing to judge for fraud.
    verdict = { verdict: "approved" as const, reason: "vanilla baseline (no custom system prompt)" };
  } else {
    try {
      verdict = await judgeSubmission(submission.prompt, getTasks());
    } catch (err) {
      const detail = (err as Error).message;
      log("error", "judge.unavailable", { submission_id: submission.id, ...normalizeError(err, "judge") });
      return NextResponse.json(
        {
          error: `The fairness judge was temporarily unavailable, so we couldn't screen your prompt. Nothing was charged — please resubmit in a moment. (${detail})`,
        },
        { status: 503 },
      );
    }
  }

  log("info", "judge.verdict", {
    submission_id: submission.id,
    verdict: verdict.verdict,
    reason: verdict.reason,
  });

  submission.judge_verdict = verdict.verdict;
  submission.judge_reason = verdict.reason;
  submission.judge_model = JUDGE_MODEL;
  submission.judged_at = new Date().toISOString();

  if (verdict.verdict === "rejected") {
    submission.status = "rejected";
    await storage.putSubmission(submission);
    return NextResponse.json({
      submission_id: submission.id,
      status: submission.status,
      judge_reason: verdict.reason,
    });
  }

  // Create the fixed sample of runs as `queued`. They are NOT started inline —
  // the dispatcher (kicked below and on every run-list poll / run completion)
  // starts them under a global concurrency cap so a burst of submissions can't
  // overwhelm the sandbox/serverless budget.
  const now = new Date().toISOString();
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

  submission.status = "queued";
  submission.run_id = runIds[0]; // first run, kept for backward-compatible readers
  submission.run_ids = runIds;
  await storage.putSubmission(submission);

  // Kick the dispatcher via after() so it runs once the response has been sent
  // but is still awaited within the invocation's lifetime. after() throws
  // synchronously if there's no live request scope (e.g. this handler invoked
  // directly, as the route tests do) -- fall back to a direct call so the
  // dispatch still fires. A failing dispatch must never fail the response.
  const kickDispatch = () =>
    dispatchQueuedRuns(storage).catch((err: unknown) =>
      log("error", "dispatch.failed", { submission_id: submission.id, ...normalizeError(err, "dispatch") }),
    );
  try {
    after(kickDispatch);
  } catch {
    void kickDispatch();
  }

  return NextResponse.json({
    submission_id: submission.id,
    run_id: runIds[0],
    run_ids: runIds,
    status: submission.status,
    judge_reason: verdict.reason,
  });
}

export async function GET() {
  const storage = getStorage();
  const submissions = await storage.listSubmissions();
  return NextResponse.json(submissions);
}
