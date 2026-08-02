import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { archiveAndDeleteCompetitionSubmissions } from "@/lib/competition-cleanup";
import { competitionAdminToken } from "@/lib/competition-config";
import { log } from "@/lib/log";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";

const CleanupRequestSchema = z.object({
  competition_id: z.string().uuid(),
  submission_ids: z.array(z.string().uuid()).min(1).max(10).refine((ids) => new Set(ids).size === ids.length, {
    message: "submission_ids must be unique",
  }),
  reason: z.string().trim().min(1).max(240),
  confirm: z.literal("archive-and-delete"),
});

const isRateLimited = createRateLimiter(5);

function isValidToken(token: string | null, expected: string): boolean {
  if (!token) return false;
  const received = Buffer.from(token);
  const configured = Buffer.from(expected);
  return received.length === configured.length && timingSafeEqual(received, configured);
}

/**
 * Archive-and-delete is deliberately a POST action rather than a general
 * deletion API. It only accepts an explicit, small set of UUIDs and requires
 * the caller to acknowledge the archive-first operation verbatim.
 */
export async function POST(request: NextRequest) {
  const expectedToken = competitionAdminToken();
  if (!expectedToken) {
    return NextResponse.json({ error: "COMPETITION_ADMIN_TOKEN is not configured on the server" }, { status: 500 });
  }

  const ip = clientIp(request);
  if (isRateLimited(ip)) {
    log("warn", "competition.admin.cleanup.rate_limited", { ip });
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }
  if (!isValidToken(request.headers.get("x-competition-admin-token"), expectedToken)) {
    return NextResponse.json({ error: "invalid or missing admin token" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid cleanup request" }, { status: 400 });
  }
  const parsed = CleanupRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid cleanup request", details: parsed.error.issues }, { status: 400 });
  }

  try {
    const cleanup = await archiveAndDeleteCompetitionSubmissions({
      competitionId: parsed.data.competition_id,
      submissionIds: parsed.data.submission_ids,
      reason: parsed.data.reason,
    });
    log("info", "competition.admin.cleanup.completed", {
      competition_id: parsed.data.competition_id,
      submission_ids: cleanup.submissionIds,
      run_ids: cleanup.runIds,
      counts: cleanup.counts,
      archive_prefix: cleanup.archivePrefix,
    });
    return NextResponse.json({
      status: "deleted",
      archive_prefix: cleanup.archivePrefix,
      submission_ids: cleanup.submissionIds,
      run_ids: cleanup.runIds,
      counts: cleanup.counts,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "cleanup failed";
    // Expected guardrail failures are safe to show. Deliberately avoid
    // serializing raw provider/blob errors into an admin response or logs.
    if (error instanceof Error && error.name === "CompetitionCleanupError") {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    log("error", "competition.admin.cleanup.failed", {
      competition_id: parsed.data.competition_id,
      submission_ids: parsed.data.submission_ids,
      error: message,
    });
    return NextResponse.json({ error: "cleanup failed before deletion; inspect server logs" }, { status: 500 });
  }
}
