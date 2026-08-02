import { NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";

export async function GET() {
  const competitions = await getStorage().listCompetitions();
  return NextResponse.json(competitions.map(({ id, arena, harness, model, gateway_provider, prize_amount_usd, prize_cadence, status, created_at }) => ({
    id, arena, harness, model, gateway_provider, prize_amount_usd: prize_amount_usd ?? null, prize_cadence: prize_cadence ?? null, status, created_at,
  })));
}
