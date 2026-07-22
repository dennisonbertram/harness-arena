import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

// Single source of truth is skill/SKILL.md (also installable directly from
// the repo) — read at request time rather than duplicating it into
// public/, so the two can never drift.
export async function GET() {
  const filePath = path.join(process.cwd(), "skill", "SKILL.md");
  const content = readFileSync(filePath, "utf8");
  return new NextResponse(content, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
