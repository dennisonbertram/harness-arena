import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { log } from "./log";

// Shared by the runner callback and trace routes. Fails closed: an unset or
// empty RUNNER_CALLBACK_SECRET always denies, even if the caller also sends
// an empty header (naive `===` comparison would otherwise let "" match "").
// sha256 digests are compared with timingSafeEqual (fixed 32-byte length,
// so this also avoids leaking secret length via a raw-string length check).
export function verifyRunnerSecret(request: NextRequest): boolean {
  const secret = process.env.RUNNER_CALLBACK_SECRET;
  if (!secret || secret === process.env.OPS_READ_TOKEN) {
    log("error", "runner_secret.unconfigured");
    return false;
  }

  const header = request.headers.get("x-runner-secret") ?? "";
  const headerDigest = createHash("sha256").update(header).digest();
  const secretDigest = createHash("sha256").update(secret).digest();
  return timingSafeEqual(headerDigest, secretDigest);
}
