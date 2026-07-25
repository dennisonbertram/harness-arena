import { NextResponse } from "next/server";
import { readVanillaPrompt } from "@/lib/vanilla-prompt";

export async function GET() {
  return new NextResponse(readVanillaPrompt(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
