import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { COMPETITION_MODEL, competitionAdminToken } from "@/lib/competition-config";
import { judgeAndDispatch } from "@/lib/competition-dispatch";
import { log } from "@/lib/log";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";
import type { Run, Submission } from "@/lib/types";
import { readVanillaPrompt } from "@/lib/vanilla-prompt";

const BASELINE_AGENT_NAME = "pi-vanilla-baseline";

// Same POC-level limiter shape as the main submission endpoints — throttles
// repeated admin-token-guessing attempts, not just legitimate use.
const isRateLimited = createRateLimiter(5);

/**
 * Whether an existing competition_baseline submission should block a new
 * baseline attempt (per R2/KTD5): blocks only while it's still "live" — the
 * submission wasn't judge-rejected AND its run is queued/running/completed.
 * A rejected submission, or one whose only run infra-failed (failed/reaped),
 * must not permanently prevent the competition from ever having a baseline.
 */
function blocksNewBaseline(submission: Submission, run: Run | undefined): boolean {
  if (submission.status === "rejected") return false;
  if (!run) return false;
  return run.status === "queued" || run.status === "running" || run.status === "completed";
}

export async function POST(request: NextRequest) {
  const token = request.headers.get("x-competition-admin-token");
  const expected = competitionAdminToken();
  if (!expected) {
    return NextResponse.json({ error: "COMPETITION_ADMIN_TOKEN is not configured on the server" }, { status: 500 });
  }
  if (!token || token !== expected) {
    return NextResponse.json({ error: "invalid or missing admin token" }, { status: 401 });
  }

  const ip = clientIp(request);
  if (isRateLimited(ip)) {
    log("warn", "competition.admin.rate_limited", { ip });
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }

  const storage = getStorage();
  const submissions = await storage.listSubmissions();
  const existingBaselines = submissions.filter((s) => s.competition_baseline === true);
  const baselineRuns = await Promise.all(
    existingBaselines.map((s) => (s.run_id ? storage.getRun(s.run_id) : Promise.resolve(undefined))),
  );
  const blockingIndex = existingBaselines.findIndex((s, i) => blocksNewBaseline(s, baselineRuns[i]));
  if (blockingIndex !== -1) {
    return NextResponse.json(
      { error: "a competition baseline already exists", submission_id: existingBaselines[blockingIndex].id },
      { status: 409 },
    );
  }

  const submission: Submission = {
    id: randomUUID(),
    agent_name: BASELINE_AGENT_NAME,
    prompt: readVanillaPrompt(),
    status: "pending_review",
    model: COMPETITION_MODEL,
    competition: true,
    competition_baseline: true,
    created_at: new Date().toISOString(),
  };
  await storage.putSubmission(submission);

  const result = await judgeAndDispatch(storage, submission, "competition.admin");
  if (result.kind === "judge_unavailable") {
    return NextResponse.json(
      {
        error: `The fairness judge was temporarily unavailable, so the baseline could not be judged. Nothing was created — please retry. (${result.error})`,
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
    status: result.submission.status,
    judge_reason: result.verdict.reason,
  });
}
