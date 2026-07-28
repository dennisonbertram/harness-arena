import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { competitionAdminToken } from "@/lib/competition-config";
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

  // Closing is deliberately idempotent: retrying a successful admin request
  // returns the original closure record without moving its closed_at timestamp.
  if (competition.status === "closed") {
    return NextResponse.json(competition);
  }

  const closed = { ...competition, status: "closed" as const, closed_at: new Date().toISOString() };
  await getStorage().putCompetition(closed);
  return NextResponse.json(closed);
}
