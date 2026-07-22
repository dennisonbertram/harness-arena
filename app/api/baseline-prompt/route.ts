import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export async function GET() {
  const filePath = path.join(process.cwd(), "docs", "pi-vanilla-system-prompt.txt");
  const content = readFileSync(filePath, "utf8");
  return new NextResponse(content, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
