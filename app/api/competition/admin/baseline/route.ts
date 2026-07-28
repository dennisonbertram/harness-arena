import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { competitionAdminToken } from "@/lib/competition-config";
import { ensureBaseline } from "@/lib/competition-baseline";
import { resolveDefaultCompetition } from "@/lib/competition-leaderboard";
import { log } from "@/lib/log";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";

const CompetitionTargetSchema = z.object({
  competition_id: z.string().min(1).optional(),
});

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

  const rawBody = await request.text();
  let parsedBody: unknown = {};
  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "invalid competition target" }, { status: 400 });
    }
  }
  const target = CompetitionTargetSchema.safeParse(parsedBody);
  if (!target.success) {
    return NextResponse.json({ error: "invalid competition target", details: target.error.issues }, { status: 400 });
  }

  const storage = getStorage();
  const competition = target.data.competition_id
    ? await storage.getCompetition(target.data.competition_id)
    : await resolveDefaultCompetition(storage);
  if (!competition) {
    return NextResponse.json({ error: "competition not found" }, { status: 404 });
  }
  if (competition.status !== "live") {
    return NextResponse.json({ error: "competition is closed" }, { status: 409 });
  }

  // Delegates to the same helper the create route and the board render use,
  // so "does this competition already have a healthy baseline?" has exactly
  // one implementation rather than one per caller.
  const result = await ensureBaseline(storage, competition);

  if (result.kind === "already_present") {
    return NextResponse.json(
      { error: "a competition baseline already exists", submission_id: result.submissionId },
      { status: 409 },
    );
  }
  if (result.kind === "judge_unavailable") {
    return NextResponse.json(
      {
        error: `The fairness judge was temporarily unavailable, so the baseline could not be judged. Nothing was created — please retry. (${result.error})`,
      },
      { status: 503 },
    );
  }
  if (result.kind === "rejected") {
    return NextResponse.json({ submission_id: result.submissionId, status: "rejected", judge_reason: result.reason });
  }
  return NextResponse.json({
    submission_id: result.submissionId,
    run_id: result.runId,
    run_ids: result.runIds,
    status: "queued",
  });
}
