import { randomUUID } from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { COMPETITION_MODEL } from "@/lib/competition-config";
import { dispatchQueuedRuns } from "@/lib/dispatch";
import { JUDGE_MODEL, judgeSubmission } from "@/lib/judge";
import { log } from "@/lib/log";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";
import { getTasks } from "@/lib/tasks";
import type { Run, Submission } from "@/lib/types";

const MAX_PROMPT_CHARS = 32768;

const SubmissionInputSchema = z.object({
  agent_name: z.string().min(1).max(40),
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
});

const isIpRateLimited = createRateLimiter(5);
// Real cash prize + single-run (non-averaged) scoring makes per-IP-only
// throttling too easy to route around (VPN/mobile IP rotation) — key a
// second bucket on agent_name so either limit alone is enough to throttle.
const isAgentNameRateLimited = createRateLimiter(5);

/**
 * Whether an existing competition submission with this prompt blocks a new
 * submission of the identical prompt (per R4/KTD5): blocks regardless of
 * judge outcome (an already-rejected duplicate is still a duplicate), EXCEPT
 * when the submission's only run ended in an infra failure (failed/reaped) —
 * that's not the submitter's fault and must not permanently burn the prompt.
 */
function blocksDuplicate(run: Run | undefined): boolean {
  return !(run && (run.status === "failed" || run.status === "reaped"));
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json({ error: "content-type must be application/json" }, { status: 415 });
  }

  const ip = clientIp(request);
  const rawBody = await request.json().catch(() => null);
  const parsedInput = SubmissionInputSchema.safeParse(rawBody);
  if (!parsedInput.success) {
    return NextResponse.json(
      { error: "invalid submission", details: parsedInput.error.issues },
      { status: 400 },
    );
  }
  const { agent_name: agentName, prompt } = parsedInput.data;

  if (isIpRateLimited(ip) || isAgentNameRateLimited(agentName)) {
    log("warn", "competition.submission.rate_limited", { ip, agent_name: agentName });
    return NextResponse.json({ error: "rate limit exceeded, max 5 submissions per hour" }, { status: 429 });
  }

  const storage = getStorage();
  const [submissions, runs] = await Promise.all([storage.listSubmissions(), storage.listRuns()]);
  const runById = new Map(runs.map((r) => [r.id, r]));
  const competitionSubmissions = submissions.filter((s) => s.competition === true);
  // ponytail: exact byte-match only (no whitespace/case normalization), and
  // list-then-compare against Vercel Blob's eventually-consistent storage is
  // not concurrency-safe — two near-simultaneous submissions of the same
  // prompt can both pass this check. Acceptable v1 scope (see plan KTD5); a
  // more robust normalized/atomic dedup is deferred to a later pass.
  const duplicate = competitionSubmissions.find(
    (s) => s.prompt === prompt && blocksDuplicate(s.run_id ? runById.get(s.run_id) : undefined),
  );
  if (duplicate) {
    return NextResponse.json({ error: "this prompt has already been submitted" }, { status: 409 });
  }

  const submission: Submission = {
    id: randomUUID(),
    agent_name: agentName,
    prompt,
    status: "pending_review",
    model: COMPETITION_MODEL,
    competition: true,
    created_at: new Date().toISOString(),
  };
  await storage.putSubmission(submission);

  let verdict;
  try {
    verdict = await judgeSubmission(submission.prompt, getTasks());
  } catch (err) {
    const detail = (err as Error).message;
    log("error", "competition.judge.unavailable", { submission_id: submission.id, error: detail });
    return NextResponse.json(
      {
        error: `The fairness judge was temporarily unavailable, so we couldn't screen your prompt. Nothing was charged — please resubmit in a moment. (${detail})`,
      },
      { status: 503 },
    );
  }

  log("info", "competition.judge.verdict", {
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

  const now = new Date().toISOString();
  const run: Run = {
    id: randomUUID(),
    submission_id: submission.id,
    status: "queued",
    model: COMPETITION_MODEL,
    task_results: [],
    created_at: now,
  };
  await storage.putRun(run);
  await storage.appendRunEvents(run.id, [
    { ts: new Date().toISOString(), type: "run.created", payload: { submission_id: submission.id } },
  ]);

  submission.status = "queued";
  submission.run_id = run.id;
  submission.run_ids = [run.id];
  await storage.putSubmission(submission);

  const kickDispatch = () =>
    dispatchQueuedRuns(storage).catch((err: unknown) =>
      log("warn", "competition.dispatch.failed", { submission_id: submission.id, error: (err as Error).message }),
    );
  try {
    after(kickDispatch);
  } catch {
    void kickDispatch();
  }

  return NextResponse.json({
    submission_id: submission.id,
    run_id: run.id,
    status: submission.status,
    judge_reason: verdict.reason,
  });
}

// Debug/inspection endpoint — NOT what the /competition page reads (it calls
// getCompetitionBoard(storage) directly, server-side). Excludes rejected
// submissions (a fraud-judge rejection may quote flagged jailbreak/injection
// text) and never returns raw prompt text, matching the main arena's
// /api/leaderboard precedent of not exposing prompt content.
export async function GET() {
  const storage = getStorage();
  const submissions = await storage.listSubmissions();
  const entries = submissions
    .filter((s) => s.competition === true && s.status !== "rejected")
    .map((s) => ({
      submission_id: s.id,
      status: s.status,
      model: s.model,
      is_baseline: s.competition_baseline === true,
      run_id: s.run_id,
      created_at: s.created_at,
    }));
  return NextResponse.json(entries);
}
