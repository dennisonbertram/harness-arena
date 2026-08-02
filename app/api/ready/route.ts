import { NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";
import { getVoiceStorage } from "@/lib/voice-storage";

export const dynamic = "force-dynamic";

/** Readiness deliberately probes storage, rather than reporting an open TCP port. */
export async function GET() {
  try {
    const storage = getStorage();
    const neutralizedKeys = (process.env.LOCAL_NEUTRALIZED_ENV_KEYS ?? "").split(",").filter(Boolean);
    const environmentSanitized = neutralizedKeys.every((key) => process.env[key] === undefined);
    if (process.env.HARNESS_LOCAL_INIT === "1" && !environmentSanitized) throw new Error("local environment neutralization failed");
    const localReadiness = "checkReady" in storage && typeof storage.checkReady === "function"
      ? await storage.checkReady()
      : { seeded: true as const, writable: true as const };
    await Promise.all([storage.listRuns(), storage.listSubmissions(), getVoiceStorage().getManifest()]);
    return NextResponse.json({
      ok: true,
      storage: "ready",
      pid: Number.parseInt(process.env.LOCAL_INSTANCE_PID ?? String(process.pid), 10),
      nonce: process.env.LOCAL_INSTANCE_NONCE ?? null,
      environment_sanitized: environmentSanitized,
      ...localReadiness,
    });
  } catch {
    return NextResponse.json({ ok: false, storage: "unready" }, { status: 503 });
  }
}
