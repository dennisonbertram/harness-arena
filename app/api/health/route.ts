import { execSync } from "node:child_process";
import { NextResponse } from "next/server";
import { getStorage, PartialReadError } from "@/lib/storage";

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
//
// "degraded" is its own state: storage answered, but not completely. This
// check was always correct -- during a live partial-read incident it
// reported "up" only because listRuns() returned a short list instead of
// throwing. Now that a partial read throws (see PartialReadError), the
// incomplete case is distinguishable from total unreachability.
async function checkStorage(): Promise<"up" | "degraded" | "down"> {
  try {
    await Promise.race([
      getStorage().listRuns(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("storage check timed out")), STORAGE_CHECK_TIMEOUT_MS)),
    ]);
    return "up";
  } catch (err) {
    return err instanceof PartialReadError ? "degraded" : "down";
  }
}

export async function GET() {
  const storage = await checkStorage();

  // `ok` and the 200 stay unconditional on purpose: ticket #1 consumers read
  // only {ok, sha} and must never break. Storage health is reported in its
  // own field -- that is the signal to alert on, not `ok`.
  return NextResponse.json({
    ok: true,
    sha: resolveSha(),
    storage,
    gateway_key_present: Boolean(process.env.AI_GATEWAY_API_KEY),
    runner_secret_present: Boolean(process.env.RUNNER_CALLBACK_SECRET),
  });
}
