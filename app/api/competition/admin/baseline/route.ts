import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, NextRequest, NextResponse } from "next/server";
import { COMPETITION_MODEL, competitionAdminToken } from "@/lib/competition-config";
import { dispatchQueuedRuns } from "@/lib/dispatch";
import { JUDGE_MODEL, judgeSubmission } from "@/lib/judge";
import { log } from "@/lib/log";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";
import { getTasks } from "@/lib/tasks";
import type { Run, Submission } from "@/lib/types";

const BASELINE_AGENT_NAME = "pi-vanilla-baseline";

// Same POC-level limiter shape as the main submission endpoints — throttles
// repeated admin-token-guessing attempts, not just legitimate use.
const isRateLimited = createRateLimiter(5);

function readVanillaPrompt(): string {
  return readFileSync(path.join(process.cwd(), "docs", "pi-vanilla-system-prompt.txt"), "utf8");
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
  const [submissions, runs] = await Promise.all([storage.listSubmissions(), storage.listRuns()]);
  const runById = new Map(runs.map((r) => [r.id, r]));
  const existingBaselines = submissions.filter((s) => s.competition_baseline === true);
  const blocking = existingBaselines.find((s) => blocksNewBaseline(s, s.run_id ? runById.get(s.run_id) : undefined));
  if (blocking) {
    return NextResponse.json(
      { error: "a competition baseline already exists", submission_id: blocking.id },
      { status: 409 },
    );
  }

  const prompt = readVanillaPrompt();
  const submission: Submission = {
    id: randomUUID(),
    agent_name: BASELINE_AGENT_NAME,
    prompt,
    status: "pending_review",
    model: COMPETITION_MODEL,
    competition: true,
    competition_baseline: true,
    created_at: new Date().toISOString(),
  };
  await storage.putSubmission(submission);

  const verdict = await judgeSubmission(prompt, getTasks());
  log("info", "competition.admin.judge_verdict", {
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
      log("warn", "competition.admin.dispatch_failed", { submission_id: submission.id, error: (err as Error).message }),
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
