import { NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Readiness deliberately probes storage, rather than reporting an open TCP port. */
export async function GET() {
  try {
    const neutralizedKeys = (process.env.LOCAL_NEUTRALIZED_ENV_KEYS ?? "").split(",").filter(Boolean);
    const environmentSanitized = neutralizedKeys.every((key) => process.env[key] === undefined);
    const isVerifiedLocalInit = process.env.HARNESS_LOCAL_INIT === "1";
    let localReadiness: { seeded: true; writable: true } | undefined;
    if (isVerifiedLocalInit) {
      // `init.sh` is the only path allowed to assert writable local readiness.
      // Never let a hosted instance (or a memory-mode test) turn this endpoint
      // into a write probe merely by setting the marker.
      if (process.env.STORAGE !== "file") throw new Error("local init requires file storage");
      if (!environmentSanitized) throw new Error("local environment neutralization failed");
      const storage = getStorage();
      if (!("checkReady" in storage) || typeof storage.checkReady !== "function") {
        throw new Error("file storage readiness probe unavailable");
      }
      localReadiness = await storage.checkReady();
    } else {
      // Hosted readiness must be bounded: constructing storage proves its
      // configuration without scanning every run/submission/voice object.
      getStorage();
    }
    return NextResponse.json({
      ok: true,
      storage: "ready",
      pid: Number.parseInt(process.env.LOCAL_INSTANCE_PID ?? String(process.pid), 10),
      nonce: process.env.LOCAL_INSTANCE_NONCE ?? null,
      environment_sanitized: environmentSanitized,
      execution_mode: isVerifiedLocalInit ? process.env.HARNESS_EXECUTION_MODE ?? null : null,
      development_identity: isVerifiedLocalInit ? process.env.HARNESS_DEVELOPMENT_IDENTITY ?? null : null,
      ...(localReadiness ?? {}),
    });
  } catch {
    return NextResponse.json({ ok: false, storage: "unready" }, { status: 503 });
  }
}
