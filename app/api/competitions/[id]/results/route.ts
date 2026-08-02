import { NextRequest, NextResponse } from "next/server";
import { projectCompetitionResults } from "@/lib/competition-entries";
import { getCompetitionBoard } from "@/lib/competition-leaderboard";
import { getStorage } from "@/lib/storage";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const storage = getStorage();
  const competition = await storage.getCompetition(id);
  if (!competition) return NextResponse.json({ error: "competition not found" }, { status: 404 });

  const board = await getCompetitionBoard(storage, id);
  return NextResponse.json(projectCompetitionResults({ competition, board }));
}
