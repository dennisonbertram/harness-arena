import { NextResponse } from "next/server";
import { getBaselinePrompt } from "@/lib/baseline-prompt";

export async function GET() {
  return new NextResponse(getBaselinePrompt(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
