import { timingSafeEqual } from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { competitionAdminToken } from "@/lib/competition-config";
import { CompetitionReplayValidationError, replayCompetition } from "@/lib/competition-replay";
import { dispatchQueuedRuns } from "@/lib/dispatch";
import { log } from "@/lib/log";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";

const ReplayBodySchema = z.object({
  competition_id: z.string().min(1),
  expected_count: z.number().int().positive().max(100),
  operation_id: z.uuid(),
  manifest_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  confirm: z.boolean().optional().default(false),
}).superRefine((body, context) => {
  if (body.confirm && !body.manifest_digest) {
    context.addIssue({ code: "custom", path: ["manifest_digest"], message: "required when confirm is true" });
  }
});

const isRateLimited = createRateLimiter(5);

function isValidToken(token: string | null, expected: string): boolean {
  if (!token) return false;
  const actualBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export async function POST(request: NextRequest) {
  const expectedToken = competitionAdminToken();
  if (!expectedToken) {
    return NextResponse.json(
      { error: "COMPETITION_ADMIN_TOKEN is not configured on the server" },
      { status: 500 },
    );
  }

  const ip = clientIp(request);
  if (isRateLimited(ip)) {
    log("warn", "competition.replay.rate_limited", { ip });
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }
  if (!isValidToken(request.headers.get("x-competition-admin-token"), expectedToken)) {
    return NextResponse.json({ error: "invalid or missing admin token" }, { status: 401 });
  }

  const parsed = ReplayBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", details: parsed.error.issues }, { status: 400 });
  }

  const storage = getStorage();
  let result;
  try {
    result = await replayCompetition(storage, {
      competitionId: parsed.data.competition_id,
      expectedCount: parsed.data.expected_count,
      operationId: parsed.data.operation_id,
      confirm: parsed.data.confirm,
      manifestDigest: parsed.data.manifest_digest,
    });
  } catch (error) {
    const validation = error instanceof CompetitionReplayValidationError;
    log(validation ? "warn" : "error", validation ? "competition.replay.validation_failed" : "competition.replay.failed", {
      competition_id: parsed.data.competition_id,
      operation_id: parsed.data.operation_id,
      error: (error as Error).message,
    });
    return validation
      ? NextResponse.json({ error: "replay validation failed" }, { status: 409 })
      : NextResponse.json(
          { error: "replay operation failed", operation_id: parsed.data.operation_id },
          { status: 500 },
        );
  }

  if (result.confirmed) {
    after(async () => {
      await dispatchQueuedRuns(storage).catch((error: unknown) => {
        log("warn", "competition.replay.dispatch_failed", {
          competition_id: result.competitionId,
          operation_id: result.operationId,
          error: (error as Error).message,
        });
      });
    });
  }

  return NextResponse.json({
    competition_id: result.competitionId,
    operation_id: result.operationId,
    pricing_version: result.pricingVersion,
    manifest_digest: result.manifestDigest,
    confirmed: result.confirmed,
    source_count: result.sourceCount,
    planned_count: result.plannedCount,
    created_count: result.createdCount,
    reused_count: result.reusedCount,
    run_ids: result.runIds,
    sources: result.sources?.map((source) => ({
      submission_id: source.submissionId,
      source_run_id: source.sourceRunId,
      baseline: source.baseline,
    })),
  });
}
