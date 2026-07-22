import { execSync } from "node:child_process";
import { NextResponse } from "next/server";

function resolveSha(): string {
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    return process.env.VERCEL_GIT_COMMIT_SHA;
  }

  try {
    return execSync("git rev-parse HEAD").toString().trim();
  } catch {
    return "dev";
  }
}

export function GET() {
  return NextResponse.json({ ok: true, sha: resolveSha() });
}
