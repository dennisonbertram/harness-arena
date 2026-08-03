import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { competitionAdminToken } from "@/lib/competition-config";
import { agentNetworkEntriesEnabled, markCompetitionEntriesClosed } from "@/lib/competition-entry-lifecycle-runtime";
import { log } from "@/lib/log";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";

const isRateLimited = createRateLimiter(5);

function isValidToken(token: string | null, expected: string): boolean {
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const expected = competitionAdminToken();
  if (!expected) {
    return NextResponse.json({ error: "COMPETITION_ADMIN_TOKEN is not configured on the server" }, { status: 500 });
  }

  const ip = clientIp(request);
  if (isRateLimited(ip)) {
    log("warn", "competition.admin.rate_limited", { ip });
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }

  if (!isValidToken(request.headers.get("x-competition-admin-token"), expected)) {
    return NextResponse.json({ error: "invalid or missing admin token" }, { status: 401 });
  }

  const competition = await getStorage().getCompetition((await params).id);
  if (!competition) {
    return NextResponse.json({ error: "competition not found" }, { status: 404 });
  }

  const proposedClosedAt = competition.status === "closed" && competition.closed_at
    ? competition.closed_at
    : new Date().toISOString();
  let closedAt = proposedClosedAt;
  if (agentNetworkEntriesEnabled()) {
    try {
      const marker = await markCompetitionEntriesClosed({ competition_id: competition.id, closed_at: proposedClosedAt });
      closedAt = marker.closed_at;
    } catch {
      log("error", "competition.admin.close_coordination_failed", { competition_id: competition.id });
      return NextResponse.json({ error: "competition close coordination unavailable" }, { status: 503 });
    }
  }

  // Closing is deliberately idempotent. Once durable entries are enabled the
  // SQL marker is written first, so a failed Blob update leaves submissions
  // safely closed and a retry reuses the original close timestamp.
  if (competition.status === "closed" && competition.closed_at === closedAt) return NextResponse.json(competition);

  const closed = { ...competition, status: "closed" as const, closed_at: closedAt };
  await getStorage().putCompetition(closed);
  return NextResponse.json(closed);
}
