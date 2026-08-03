import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { log, normalizeError } from "@/lib/log";
import { comparisonIdFor } from "@/lib/voice-session";
import { getVoiceStorage } from "@/lib/voice-storage";
import { verifyVoiceCapability } from "@/lib/voice-capability";
import { VOICE_JUDGMENT_REASONS, VOICE_OUTCOMES, VoicePlayCountsSchema } from "@/lib/voice-types";
import type { VoiceJudgment } from "@/lib/voice-types";

const COOKIE_NAME = "voice_evaluator";
const MAX_BODY_BYTES = 65536; // 64KB

const JudgmentInputSchema = z.object({
  response_a_id: z.string(),
  response_b_id: z.string(),
  outcome: z.enum(VOICE_OUTCOMES),
  reason: z.enum(VOICE_JUDGMENT_REASONS).optional(),
  free_text: z.string().max(2000).optional(),
  play_counts: VoicePlayCountsSchema,
  time_to_judgment_ms: z.number(),
  // Any other field (notably a client-supplied evaluator_id) is silently
  // stripped by zod's default object mode -- identity comes from the cookie
  // only, never from the body.
});

// ponytail: naive in-memory per-IP rate limit, same POC-level pattern as
// app/api/submissions/route.ts -- per-process state, not a real abuse
// boundary on serverless. Upgrade to a shared store (e.g. Redis) if that
// ever matters.
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 120;
const judgmentTimestamps = new Map<string, number[]>();

function isRateLimited(ip: string, now: number = Date.now()): boolean {
  const recent = (judgmentTimestamps.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  const limited = recent.length >= RATE_LIMIT_MAX;
  if (!limited) recent.push(now);
  judgmentTimestamps.set(ip, recent);
  return limited;
}

function clientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

// A malformed cookie value is rejected the same as an absent one -- the
// client is told to re-mint via GET /api/voice/next rather than trusting an
// unvalidated value as an evaluator identity.
function validEvaluatorId(request: NextRequest): string | undefined {
  return verifyVoiceCapability(request.cookies.get(COOKIE_NAME)?.value);
}

export async function POST(request: NextRequest) {
  const evaluatorId = validEvaluatorId(request);
  if (!evaluatorId) {
    return NextResponse.json({ error: "no evaluator cookie; call GET /api/voice/next" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json({ error: "content-type must be application/json" }, { status: 415 });
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "request body too large" }, { status: 413 });
  }

  const ip = clientIp(request);
  if (isRateLimited(ip)) {
    log("warn", "voice.judgment.rate_limited", { ip });
    return NextResponse.json({ error: "rate limit exceeded, max 120 judgments per hour" }, { status: 429 });
  }

  const rawBody = await request.json().catch(() => null);
  const parsedInput = JudgmentInputSchema.safeParse(rawBody);
  if (!parsedInput.success) {
    log("warn", "voice.judgment.invalid", { evaluator_id: evaluatorId, issues: parsedInput.error.issues });
    return NextResponse.json({ error: "invalid judgment", details: parsedInput.error.issues }, { status: 400 });
  }

  const storage = getVoiceStorage();
  const manifest = await storage.getManifest();
  if (!manifest) {
    return NextResponse.json({ error: "not seeded" }, { status: 409 });
  }

  const { response_a_id, response_b_id } = parsedInput.data;
  const responseA = manifest.responses.find((r) => r.id === response_a_id);
  const responseB = manifest.responses.find((r) => r.id === response_b_id);

  if (!responseA || !responseB) {
    return NextResponse.json({ error: "unknown response id" }, { status: 400 });
  }
  if (response_a_id === response_b_id) {
    return NextResponse.json({ error: "response_a_id and response_b_id must differ" }, { status: 400 });
  }
  if (responseA.prompt_id !== responseB.prompt_id) {
    return NextResponse.json({ error: "responses must share a prompt" }, { status: 400 });
  }
  if (responseA.model_id === responseB.model_id) {
    return NextResponse.json({ error: "responses must be from two different models" }, { status: 400 });
  }

  const judgment: VoiceJudgment = {
    comparison_id: comparisonIdFor(response_a_id, response_b_id),
    evaluator_id: evaluatorId,
    prompt_id: responseA.prompt_id,
    response_a_id,
    response_b_id,
    outcome: parsedInput.data.outcome,
    reason: parsedInput.data.reason,
    free_text: parsedInput.data.free_text,
    play_counts: parsedInput.data.play_counts,
    time_to_judgment_ms: parsedInput.data.time_to_judgment_ms,
    created_at: new Date().toISOString(),
  };

  let result: { created: boolean };
  try {
    result = await storage.putJudgment(judgment);
  } catch (err) {
    // Only an "already exists" conflict is a safe no-op (handled inside
    // putJudgment itself); anything reaching here is a real storage failure
    // and must not be reported as success.
    log("error", "voice.judgment.store_failed", {
      comparison_id: judgment.comparison_id,
      evaluator_id: evaluatorId,
      ...normalizeError(err, "judgment_store"),
    });
    return NextResponse.json({ error: "failed to store judgment" }, { status: 500 });
  }

  log("info", "voice.judgment.stored", {
    comparison_id: judgment.comparison_id,
    evaluator_id: evaluatorId,
    outcome: judgment.outcome,
    created: result.created,
  });

  return NextResponse.json({ stored: true, created: result.created });
}
