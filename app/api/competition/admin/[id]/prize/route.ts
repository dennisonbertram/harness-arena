import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { competitionAdminToken } from "@/lib/competition-config";
import { log } from "@/lib/log";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";
import { PRIZE_CADENCES } from "@/lib/types";

const PrizeSchema = z.object({
  prize_amount_usd: z.number().nonnegative(),
  prize_cadence: z.enum(PRIZE_CADENCES),
});

const isRateLimited = createRateLimiter(5);

function isValidToken(token: string | null, expected: string): boolean {
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const parsedInput = PrizeSchema.safeParse(await request.json().catch(() => null));
  if (!parsedInput.success) {
    return NextResponse.json({ error: "invalid body", details: parsedInput.error.issues }, { status: 400 });
  }

  const competition = await getStorage().getCompetition((await params).id);
  if (!competition) {
    return NextResponse.json({ error: "competition not found" }, { status: 404 });
  }

  const updated = { ...competition, ...parsedInput.data };
  await getStorage().putCompetition(updated);
  return NextResponse.json(updated);
}
