import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { JUDGE_MODEL, judgeSubmission } from "@/lib/judge";
import { log } from "@/lib/log";
import { startRun } from "@/lib/run-trigger";
import { getStorage } from "@/lib/storage";
import { getTasks } from "@/lib/tasks";
import type { Run, Submission } from "@/lib/types";

const MAX_PROMPT_CHARS = 32768;
const MAX_BODY_BYTES = 262144;

const SubmissionInputSchema = z.object({
  agent_name: z.string().min(1).max(40),
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
});

// ponytail: naive in-memory per-IP rate limit — explicitly POC-level, not a
// real abuse boundary. It's per-process state, so on serverless (each
// invocation may be a separate instance/cold start) this does not actually
// enforce a global 5/hour limit across all traffic to an IP; upgrade to a
// shared store (e.g. Redis) if that ever matters.
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const submissionTimestamps = new Map<string, number[]>();

function isRateLimited(ip: string, now: number = Date.now()): boolean {
  const recent = (submissionTimestamps.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  const limited = recent.length >= RATE_LIMIT_MAX;
  if (!limited) recent.push(now);
  submissionTimestamps.set(ip, recent);
  return limited;
}

function clientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json({ error: "content-type must be application/json" }, { status: 415 });
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "request body too large" }, { status: 413 });
  }

  const ip = clientIp(request);
  if (isRateLimited(ip)) {
    log("warn", "submission.rate_limited", { ip });
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

  const storage = getStorage();
  const submission: Submission = {
    id: randomUUID(),
    agent_name: parsedInput.data.agent_name,
    prompt: parsedInput.data.prompt,
    status: "pending_review",
    created_at: new Date().toISOString(),
  };
  await storage.putSubmission(submission);

  let verdict;
  try {
    verdict = await judgeSubmission(submission.prompt, getTasks());
  } catch (err) {
    log("error", "judge.unavailable", { submission_id: submission.id, error: (err as Error).message });
    return NextResponse.json({ error: "judge unavailable, retry later" }, { status: 503 });
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

  const run: Run = {
    id: randomUUID(),
    submission_id: submission.id,
    status: "queued",
    task_results: [],
    created_at: new Date().toISOString(),
  };
  await storage.putRun(run);
  await storage.appendRunEvents(run.id, [
    { ts: new Date().toISOString(), type: "run.created", payload: { submission_id: submission.id } },
  ]);

  submission.status = "queued";
  submission.run_id = run.id;
  await storage.putSubmission(submission);

  // Fire-and-forget: a failing/stubbed trigger must never fail the
  // submission response (ticket #7 implements the real sandbox creation).
  void startRun(run).catch((err) => {
    log("warn", "run-trigger.failed", { run_id: run.id, error: (err as Error).message });
  });

  return NextResponse.json({ submission_id: submission.id, run_id: run.id, status: submission.status });
}

export async function GET() {
  const storage = getStorage();
  const submissions = await storage.listSubmissions();
  return NextResponse.json(submissions);
}
