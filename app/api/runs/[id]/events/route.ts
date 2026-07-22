import { NextRequest, NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const storage = getStorage();
  const events = await storage.listRunEvents(id);
  return NextResponse.json(events);
}
