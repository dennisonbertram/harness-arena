import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { COMPETITION_MODEL, competitionAdminToken } from "@/lib/competition-config";
import { isInfraFailedRun, judgeAndDispatch } from "@/lib/competition-dispatch";
import { log } from "@/lib/log";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";
import type { Run, Submission } from "@/lib/types";
import { getBaselinePrompt } from "@/lib/baseline-prompt";

const BASELINE_AGENT_NAME = "pi-vanilla-baseline";

// Same POC-level limiter shape as the main submission endpoints — throttles
// repeated admin-token-guessing attempts, not just legitimate use. Must run
// BEFORE the token check below (not after) or a wrong-token request never
// reaches this call and guessing goes completely unthrottled.
const isRateLimited = createRateLimiter(5);

function isValidToken(token: string | null, expected: string): boolean {
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch; a length difference isn't
  // secret, so a plain false there is fine (still not a timing leak of the
  // token's actual bytes).
  return a.length === b.length && timingSafeEqual(a, b);
}

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
  return !isInfraFailedRun(run);
}

export async function POST(request: NextRequest) {
  const expected = competitionAdminToken();
  if (!expected) {
    return NextResponse.json({ error: "COMPETITION_ADMIN_TOKEN is not configured on the server" }, { status: 500 });
  }

  const ip = clientIp(request);
  if (isRateLimited(ip)) {
    log("warn", "competition.admin.rate_limited", { ip });
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }

  const token = request.headers.get("x-competition-admin-token");
  if (!isValidToken(token, expected)) {
    return NextResponse.json({ error: "invalid or missing admin token" }, { status: 401 });
  }

  const storage = getStorage();
  const submissions = await storage.listSubmissions();
  const existingBaselines = submissions.filter((s) => s.competition_baseline === true);
  // ponytail: same list-then-point-fetch TOCTOU gap as the submissions
  // route's dedup check (not concurrency-safe against Blob's eventual
  // consistency) — two near-simultaneous admin triggers could both pass this
  // and create two baseline submissions. Low-likelihood (single admin,
  // deliberate rare action) and low-impact (getCompetitionBoard only ever
  // surfaces the first baseline it finds; a second would just sit unused).
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
    prompt: getBaselinePrompt(),
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
    run_ids: result.submission.run_ids,
    status: result.submission.status,
    judge_reason: result.verdict.reason,
  });
}
