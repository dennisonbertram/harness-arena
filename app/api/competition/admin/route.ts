import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { competitionAdminToken } from "@/lib/competition-config";
import { log } from "@/lib/log";
import { isAllowedModel } from "@/lib/models";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";
import { PRIZE_CADENCES, type Competition } from "@/lib/types";

const CreateCompetitionSchema = z
  .object({
    arena: z.string().min(1),
    harness: z.string().min(1),
    model: z.string().min(1),
    prize_amount_usd: z.number().nonnegative().optional(),
    prize_cadence: z.enum(PRIZE_CADENCES).optional(),
  })
  .refine(
    ({ prize_amount_usd, prize_cadence }) =>
      (prize_amount_usd === undefined) === (prize_cadence === undefined),
    { message: "prize_amount_usd and prize_cadence must be provided together" },
  );

// Same POC-level limiter shape as the baseline endpoint. It runs before
// authentication so repeated token guesses are throttled too.
const isRateLimited = createRateLimiter(5);

function isValidToken(token: string | null, expected: string): boolean {
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
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

  const parsedInput = CreateCompetitionSchema.safeParse(await request.json().catch(() => null));
  if (!parsedInput.success) {
    return NextResponse.json({ error: "invalid body", details: parsedInput.error.issues }, { status: 400 });
  }

  const input = parsedInput.data;
  if (!isAllowedModel(input.model)) {
    return NextResponse.json({ error: `model "${input.model}" is not allowed` }, { status: 400 });
  }

  const competition: Competition = {
    id: randomUUID(),
    arena: input.arena,
    harness: input.harness,
    model: input.model,
    prize_amount_usd: input.prize_amount_usd ?? null,
    prize_cadence: input.prize_cadence ?? null,
    status: "live",
    created_at: new Date().toISOString(),
  };
  await getStorage().putCompetition(competition);

  return NextResponse.json(competition, { status: 201 });
}
