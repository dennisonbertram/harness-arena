import { NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";

export async function GET() {
  const storage = getStorage();
  const runs = await storage.listRuns();
  return NextResponse.json(runs);
}
