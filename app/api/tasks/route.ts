import { NextResponse } from "next/server";
import { getTasks } from "@/lib/tasks";

export async function GET() {
  return NextResponse.json(getTasks().map(({ id, instruction }) => ({ id, description: instruction })));
}
