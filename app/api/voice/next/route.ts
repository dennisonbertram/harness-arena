import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { log } from "@/lib/log";
import type { NextComparison, Progress } from "@/lib/voice-session";
import { enumerateComparisons, pickNext, progress } from "@/lib/voice-session";
import type { VoiceManifest } from "@/lib/voice-types";
import { getVoiceStorage } from "@/lib/voice-storage";
import { mintVoiceCapability, verifyVoiceCapability, VOICE_CAPABILITY_LIFETIME_SECONDS } from "@/lib/voice-capability";

const COOKIE_NAME = "voice_evaluator";
const COOKIE_MAX_AGE_SECONDS = VOICE_CAPABILITY_LIFETIME_SECONDS;
const EXCLUDE_CAP = 25;

const audioUrl = (kind: "prompts" | "responses", id: string) => `/api/voice/audio/${kind}/${encodeURIComponent(id)}`;

// ponytail: naive in-memory per-IP cap on cookie *minting* — POC-level, not
// a real abuse boundary, and per-process (serverless cold starts reset it;
// upgrade to a shared store like Redis if that ever matters). Loose because
// a real evaluator mints once per session; this only bites cookie-less
// clients hammering the endpoint for fresh identities.
const MINT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const MINT_RATE_LIMIT_MAX = 30;
const mintTimestamps = new Map<string, number[]>();

function isMintRateLimited(ip: string, now: number = Date.now()): boolean {
  const recent = (mintTimestamps.get(ip) ?? []).filter((t) => now - t < MINT_RATE_LIMIT_WINDOW_MS);
  const limited = recent.length >= MINT_RATE_LIMIT_MAX;
  if (!limited) recent.push(now);
  mintTimestamps.set(ip, recent);
  return limited;
}

function clientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

// A malformed cookie value is treated the same as an absent one -- re-mint
// rather than 500 or trust an unvalidated value as an evaluator identity.
function validEvaluatorId(request: NextRequest): string | undefined {
  return verifyVoiceCapability(request.cookies.get(COOKIE_NAME)?.value);
}

function parseExclude(request: NextRequest): string[] {
  const raw = request.nextUrl.searchParams.get("exclude");
  if (!raw) return [];
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  // Client is asked to send at most 25; a longer list is trimmed to the most
  // recent (last) 25 rather than rejected outright.
  return ids.length > EXCLUDE_CAP ? ids.slice(-EXCLUDE_CAP) : ids;
}

function setEvaluatorCookie(response: NextResponse, evaluatorId: string): void {
  response.cookies.set(COOKIE_NAME, mintVoiceCapability(evaluatorId), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    secure: true,
  });
}

// Never include model_id/name here -- this payload is the blinding boundary.
function buildComparisonPayload(manifest: VoiceManifest, result: NextComparison, currentProgress: Progress) {
  const prompt = manifest.prompts.find((p) => p.id === result.promptId);
  const first = manifest.responses.find((r) => r.id === result.first);
  const second = manifest.responses.find((r) => r.id === result.second);
  if (!prompt || !first || !second) {
    // pickNext only draws IDs enumerated from this same manifest, so this
    // would mean a manifest read inconsistent with itself.
    throw new Error("voice: pickNext returned an id not present in the manifest");
  }
  return {
    comparisonId: result.comparisonId,
    prompt: { audioUrl: audioUrl("prompts", prompt.id), text: prompt.text },
    clipA: { responseId: first.id, audioUrl: audioUrl("responses", first.id) },
    clipB: { responseId: second.id, audioUrl: audioUrl("responses", second.id) },
    progress: currentProgress,
  };
}

export async function GET(request: NextRequest) {
  const ip = clientIp(request);
  const existingId = validEvaluatorId(request);
  let evaluatorId = existingId;
  let minted = false;

  if (!evaluatorId) {
    if (isMintRateLimited(ip)) {
      log("warn", "voice.evaluator.mint_rate_limited", { ip });
      return NextResponse.json(
        { error: "too many new evaluator sessions from this IP, try again later" },
        { status: 429 },
      );
    }
    evaluatorId = randomUUID();
    minted = true;
    log("info", "voice.evaluator.minted", { evaluator_id: evaluatorId, ip });
  }

  const storage = getVoiceStorage();
  const manifest = await storage.getManifest();
  if (!manifest) {
    const response = NextResponse.json({ not_seeded: true });
    if (minted) setEvaluatorCookie(response, evaluatorId);
    return response;
  }

  // A re-seed can orphan judgment keys from a prior manifest's comparison
  // set; counting those would report judged > total. Filter to the current
  // manifest's comparisons before using the count (cheap: one enumeration,
  // already O(prompts×models²) tiny).
  const currentComparisonIds = new Set(enumerateComparisons(manifest).map((c) => c.comparisonId));
  const judged = (await storage.listJudgmentKeys(evaluatorId)).filter((id) => currentComparisonIds.has(id));
  const exclude = parseExclude(request);
  // Routes are the composition root: pickNext/progress are pure over an
  // injected rng, and Math.random is supplied here rather than baked in.
  const result = pickNext(manifest, judged, exclude, Math.random);
  const currentProgress = progress(manifest, judged.length);

  const body = result.done
    ? { done: true as const, progress: currentProgress }
    : buildComparisonPayload(manifest, result, currentProgress);

  const response = NextResponse.json(body);
  if (minted) setEvaluatorCookie(response, evaluatorId);
  return response;
}
