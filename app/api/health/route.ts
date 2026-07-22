import { execSync } from "node:child_process";
import { NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";

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

const STORAGE_CHECK_TIMEOUT_MS = 2000;

// Cheap reachability check: a real listRuns() call (catches both
// getStorage() misconfiguration and a listRuns() failure), raced against a
// timeout so an unresponsive backend can't hang the health check forever.
async function checkStorage(): Promise<"up" | "down"> {
  try {
    await Promise.race([
      getStorage().listRuns(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("storage check timed out")), STORAGE_CHECK_TIMEOUT_MS)),
    ]);
    return "up";
  } catch {
    return "down";
  }
}

export async function GET() {
  const storage = await checkStorage();

  return NextResponse.json({
    ok: true,
    sha: resolveSha(),
    storage,
    gateway_key_present: Boolean(process.env.AI_GATEWAY_API_KEY),
    runner_secret_present: Boolean(process.env.RUNNER_CALLBACK_SECRET),
  });
}
