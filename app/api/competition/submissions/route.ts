import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { COMPETITION_MODEL } from "@/lib/competition-config";
import { isInfraFailedRun, judgeAndDispatch } from "@/lib/competition-dispatch";
import { log } from "@/lib/log";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";
import type { Submission } from "@/lib/types";

const MAX_PROMPT_CHARS = 32768;
const MAX_BODY_BYTES = 262144;

const SubmissionInputSchema = z.object({
  agent_name: z.string().min(1).max(40),
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
});

const isIpRateLimited = createRateLimiter(5);
// Real cash prize + single-run (non-averaged) scoring makes per-IP-only
// throttling too easy to route around (VPN/mobile IP rotation) — key a
// second bucket on the signed-in GitHub account (replaces the old
// agent-name bucket now that github_id is the real identity axis) so either
// limit alone is enough to throttle.
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

  // IP-based check runs before the body is even read (matches the main
  // arena's /api/submissions ordering) so a flood of malformed/oversized
  // requests still burns rate-limit budget instead of getting a free 400.
  const ip = clientIp(request);
  if (isIpRateLimited(ip)) {
    log("warn", "competition.submission.rate_limited", { ip });
    return NextResponse.json({ error: "rate limit exceeded, max 5 submissions per hour" }, { status: 429 });
  }

  const session = await auth();
  const githubId = session?.user?.githubId;
  const githubLogin = session?.user?.githubLogin;
  if (githubId === undefined || githubLogin === undefined) {
    return NextResponse.json({ error: "sign in with GitHub to submit" }, { status: 401 });
  }

  if (isGithubIdRateLimited(String(githubId))) {
    log("warn", "competition.submission.rate_limited", { ip, github_id: githubId });
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
  const { agent_name: agentName, prompt } = parsedInput.data;

  const storage = getStorage();
  const competitionSubmissions = (await storage.listSubmissions()).filter((s) => s.competition === true);
  const candidates = competitionSubmissions.filter((s) => s.prompt === prompt);
  const candidateRuns = await Promise.all(
    candidates.map((s) => (s.run_id ? storage.getRun(s.run_id) : Promise.resolve(undefined))),
  );
  // ponytail: exact byte-match only (no whitespace/case normalization), and
  // this list-then-point-fetch check against Vercel Blob's eventually-consistent
  // storage is not concurrency-safe — two near-simultaneous submissions of the
  // same prompt can both pass it. Acceptable v1 scope (see plan KTD5); a more
  // robust normalized/atomic dedup is deferred to a later pass.
  //
  // Blocks regardless of judge outcome (per R4/KTD5) — a duplicate of an
  // already-rejected prompt is still a duplicate — EXCEPT when the match's
  // only run infra-failed (failed/reaped): that's not the submitter's fault
  // and must not permanently burn the prompt.
  const duplicate = candidates.some((_, i) => !isInfraFailedRun(candidateRuns[i]));
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
    github_id: githubId,
    github_login: githubLogin,
    created_at: new Date().toISOString(),
  };
  await storage.putSubmission(submission);

  const result = await judgeAndDispatch(storage, submission, "competition");
  if (result.kind === "judge_unavailable") {
    return NextResponse.json(
      {
        error: `The fairness judge was temporarily unavailable, so we couldn't screen your prompt. Nothing was charged — please resubmit in a moment. (${result.error})`,
      },
      { status: 503 },
    );
  }
  if (result.kind === "rejected") {
    return NextResponse.json({
      submission_id: result.submission.id,
      status: result.submission.status,
      judge_reason: result.verdict.reason,
    });
  }
  return NextResponse.json({
    submission_id: result.submission.id,
    run_id: result.run.id,
    run_ids: result.submission.run_ids,
    status: result.submission.status,
    judge_reason: result.verdict.reason,
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
      github_login: s.github_login,
      run_id: s.run_id,
      created_at: s.created_at,
    }));
  return NextResponse.json(entries);
}
