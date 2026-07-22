import { NextRequest, NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const storage = getStorage();
  const submission = await storage.getSubmission(id);
  if (!submission) {
    return NextResponse.json({ error: "submission not found" }, { status: 404 });
  }
  return NextResponse.json(submission);
}
