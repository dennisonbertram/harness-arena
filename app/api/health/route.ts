import { execSync } from "node:child_process";
import { NextResponse } from "next/server";
import { getStorage, PartialReadError } from "@/lib/storage";
import { credentialSeparationAttestation } from "@/lib/credential-separation.mjs";

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

// Cheap reachability check: real list calls (catching both getStorage()
// misconfiguration and a read failure), raced against a timeout so an
// unresponsive backend can't hang the health check forever.
//
// BOTH entity lists are probed, in parallel. The leaderboard joins runs to
// submissions, and the incident this guards against was submission-side: a
// run whose submission failed to read is keyed `__unknown:<runId>` and
// becomes a fabricated standing. Probing only runs/ would report "up"
// through exactly the failure mode that corrupts the leaderboard.
//
// "degraded" is its own state: storage answered, but not completely. This
// check was always correct -- during the live incident it reported "up"
// only because the list calls returned short lists instead of throwing.
// Now that a partial read throws (see PartialReadError), incomplete is
// distinguishable from unreachable.
async function checkStorage(): Promise<"up" | "degraded" | "down"> {
  const storage = getStorage();
  try {
    await Promise.race([
      Promise.all([storage.listRuns(), storage.listSubmissions()]),
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
    credential_separation: credentialSeparationAttestation(process.env),
  });
}
