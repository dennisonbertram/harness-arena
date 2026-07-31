import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { dispatchQueuedRuns } from "./dispatch";
import { JUDGE_MODEL, judgeSubmission, type JudgeVerdict } from "./judge";
import { log } from "./log";
import type { Storage } from "./storage";
import { getTasks } from "./tasks";
import type { Run, Submission } from "./types";

/** A run that ended in infra failure (not the submitter's/admin's fault) — shared by both competition routes' duplicate/retry guards. */
export function isInfraFailedRun(run: Run | undefined): boolean {
  if (!run) return false;
  if (run.status === "failed" || run.status === "reaped") return true;

  // The runner is intentionally task-resilient: it keeps going after a task
  // cannot reach the model and can therefore finish a broken transport as a
  // formally "completed" 0/16 run. Treat the narrow zero-output form as
  // infrastructure failure so a baseline or entrant may be retried. A
  // provider error after productive turns is deliberately not included; that
  // can be a real model/provider interaction and needs to remain visible.
  return (
    run.status === "completed" &&
    run.task_results.length > 0 &&
    run.task_results.every(
      (result) =>
        result.attempted &&
        !result.passed &&
        (result.failure_stage === "provider_error" || result.failure_stage === "provider_timeout") &&
        (result.turns ?? 0) <= 1 &&
        (result.output_tokens ?? 0) === 0,
    )
  );
}

export type JudgeAndDispatchResult =
  | { kind: "judge_unavailable"; error: string }
  | { kind: "rejected"; submission: Submission; verdict: JudgeVerdict }
  | { kind: "queued"; submission: Submission; run: Run; verdict: JudgeVerdict };

/**
 * Shared judge -> run-creation -> dispatch pipeline for the two competition
 * routes (admin baseline trigger, regular submissions): judges the
 * submission's prompt, persists the verdict, and on approval creates exactly
 * one queued Run and kicks the dispatcher. The caller must already have
 * persisted `submission` (status: "pending_review") before calling this, and
 * owns building the HTTP response from the returned result.
 */
export async function judgeAndDispatch(
  storage: Storage,
  submission: Submission,
  logPrefix: string,
): Promise<JudgeAndDispatchResult> {
  let verdict: JudgeVerdict;
  try {
    verdict = await judgeSubmission(submission.prompt, getTasks());
  } catch (err) {
    const detail = (err as Error).message;
    log("error", `${logPrefix}.judge_unavailable`, { submission_id: submission.id, error: detail });
    return { kind: "judge_unavailable", error: detail };
  }

  log("info", `${logPrefix}.judge_verdict`, {
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
    return { kind: "rejected", submission, verdict };
  }

  const run: Run = {
    id: randomUUID(),
    submission_id: submission.id,
    status: "queued",
    model: submission.model,
    provider_requested: submission.gateway_provider,
    task_results: [],
    created_at: new Date().toISOString(),
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
      log("warn", `${logPrefix}.dispatch_failed`, { submission_id: submission.id, error: (err as Error).message }),
    );
  try {
    after(kickDispatch);
  } catch {
    void kickDispatch();
  }

  return { kind: "queued", submission, run, verdict };
}
