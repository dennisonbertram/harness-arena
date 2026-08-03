import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { comparisonIdFor } from "@/lib/voice-session";
import { resetVoiceStorage, voiceStorageRef } from "@/lib/test-support/voice-storage-ref";
import { installVoiceCapabilityTestSecret, voiceCapabilityCookie } from "@/lib/test-support/voice-capability";
import type { VoiceManifest } from "@/lib/voice-types";

vi.mock("@/lib/voice-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voice-storage")>();
  return { ...actual, getVoiceStorage: () => voiceStorageRef.current };
});

import { POST } from "./route";

const MODEL_1 = "model-aurora";
const MODEL_2 = "model-borealis";

// prompt-1: resp-1a (model-1), resp-1b (model-2), resp-1x (model-1 again --
// exists solely to exercise the "same model" 400 case). prompt-2: resp-2a
// (model-1), resp-2b (model-2), used for the cross-prompt 400 case.
function buildManifest(): VoiceManifest {
  return {
    version: "1",
    created_at: "2026-07-01T00:00:00.000Z",
    models: [
      { id: MODEL_1, name: "Aurora" },
      { id: MODEL_2, name: "Borealis" },
    ],
    prompts: [
      { id: "prompt-1", text: "Say hello to the team.", audio_url: "https://blob.example/prompts/prompt-1.wav" },
      { id: "prompt-2", audio_url: "https://blob.example/prompts/prompt-2.wav" },
    ],
    responses: [
      { id: "resp-1a", prompt_id: "prompt-1", model_id: MODEL_1, audio_url: "https://blob.example/r/resp-1a.wav" },
      { id: "resp-1b", prompt_id: "prompt-1", model_id: MODEL_2, audio_url: "https://blob.example/r/resp-1b.wav" },
      { id: "resp-1x", prompt_id: "prompt-1", model_id: MODEL_1, audio_url: "https://blob.example/r/resp-1x.wav" },
      { id: "resp-2a", prompt_id: "prompt-2", model_id: MODEL_1, audio_url: "https://blob.example/r/resp-2a.wav" },
      { id: "resp-2b", prompt_id: "prompt-2", model_id: MODEL_2, audio_url: "https://blob.example/r/resp-2b.wav" },
    ],
  };
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    response_a_id: "resp-1a",
    response_b_id: "resp-1b",
    outcome: "a",
    reason: "more_natural_voice",
    free_text: "Sounded more human.",
    play_counts: { prompt: 1, a: 2, b: 1 },
    time_to_judgment_ms: 4500,
    ...overrides,
  };
}

function postRequest(
  body: unknown,
  opts: { evaluatorId?: string; ip?: string } = {},
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": opts.ip ?? "1.1.1.1",
  };
  if (opts.evaluatorId) headers.cookie = `voice_evaluator=${opts.evaluatorId === "not-a-uuid" ? opts.evaluatorId : voiceCapabilityCookie(opts.evaluatorId)}`;
  return new NextRequest("http://localhost/api/voice/judgments", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function postRequestRaw(
  body: string,
  headers: Record<string, string>,
  opts: { evaluatorId?: string; ip?: string } = {},
): NextRequest {
  const allHeaders: Record<string, string> = { "x-forwarded-for": opts.ip ?? "1.1.1.1", ...headers };
  if (opts.evaluatorId) allHeaders.cookie = `voice_evaluator=${opts.evaluatorId === "not-a-uuid" ? opts.evaluatorId : voiceCapabilityCookie(opts.evaluatorId)}`;
  return new NextRequest("http://localhost/api/voice/judgments", { method: "POST", headers: allHeaders, body });
}

async function storedJudgmentCount(): Promise<number> {
  const { judgments } = await voiceStorageRef.current.listAllJudgments();
  return judgments.length;
}

describe("POST /api/voice/judgments", () => {
  let evaluatorId: string;

  beforeEach(async () => {
    installVoiceCapabilityTestSecret();
    resetVoiceStorage();
    evaluatorId = randomUUID();
    await voiceStorageRef.current.putManifest(buildManifest());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("authentication", () => {
    it("returns 401 with no cookie and writes nothing", async () => {
      const response = await POST(postRequest(validPayload(), { ip: "2.2.2.1" }));

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toEqual({ error: "no evaluator cookie; call GET /api/voice/next" });
      expect(await storedJudgmentCount()).toBe(0);
    });

    it("returns 401 with a malformed cookie value and writes nothing", async () => {
      const response = await POST(
        postRequest(validPayload(), { evaluatorId: "not-a-uuid", ip: "2.2.2.2" }),
      );

      expect(response.status).toBe(401);
      expect(await storedJudgmentCount()).toBe(0);
    });
  });

  describe("schema validation", () => {
    it("returns 400 with 'invalid judgment' for a schema-invalid outcome and writes nothing", async () => {
      const response = await POST(
        postRequest(validPayload({ outcome: "c" }), { evaluatorId, ip: "3.3.3.5" }),
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("invalid judgment");
      expect(await storedJudgmentCount()).toBe(0);
    });
  });

  describe("business validation", () => {
    it("returns 400 when response IDs come from different prompts", async () => {
      const response = await POST(
        postRequest(validPayload({ response_a_id: "resp-1a", response_b_id: "resp-2b" }), {
          evaluatorId,
          ip: "3.3.3.1",
        }),
      );

      expect(response.status).toBe(400);
      expect(await storedJudgmentCount()).toBe(0);
    });

    it("returns 400 when a response ID is unknown", async () => {
      const response = await POST(
        postRequest(validPayload({ response_b_id: "does-not-exist" }), { evaluatorId, ip: "3.3.3.2" }),
      );

      expect(response.status).toBe(400);
      expect(await storedJudgmentCount()).toBe(0);
    });

    it("returns 400 when response_a_id and response_b_id are the same ID", async () => {
      const response = await POST(
        postRequest(validPayload({ response_a_id: "resp-1a", response_b_id: "resp-1a" }), {
          evaluatorId,
          ip: "3.3.3.3",
        }),
      );

      expect(response.status).toBe(400);
      expect(await storedJudgmentCount()).toBe(0);
    });

    it("returns 400 when both responses resolve to the same model", async () => {
      const response = await POST(
        postRequest(validPayload({ response_a_id: "resp-1a", response_b_id: "resp-1x" }), {
          evaluatorId,
          ip: "3.3.3.4",
        }),
      );

      expect(response.status).toBe(400);
      expect(await storedJudgmentCount()).toBe(0);
    });
  });

  describe("input hardening", () => {
    it("returns 415 for a non-JSON content-type", async () => {
      const response = await POST(
        postRequestRaw(JSON.stringify(validPayload()), { "content-type": "text/plain" }, { evaluatorId, ip: "4.4.4.1" }),
      );

      expect(response.status).toBe(415);
      expect(await storedJudgmentCount()).toBe(0);
    });

    it("returns 413 when content-length exceeds 64KB", async () => {
      const oversized = JSON.stringify(validPayload({ free_text: "a".repeat(70000) }));
      const response = await POST(
        postRequestRaw(
          oversized,
          { "content-type": "application/json", "content-length": String(oversized.length) },
          { evaluatorId, ip: "4.4.4.2" },
        ),
      );

      expect(response.status).toBe(413);
      expect(await storedJudgmentCount()).toBe(0);
    });

    it("returns 429 once the per-IP rate limit (120/hour) is exceeded", async () => {
      const ip = "4.4.4.3";
      for (let i = 0; i < 120; i++) {
        const response = await POST(postRequest(validPayload(), { evaluatorId, ip }));
        expect(response.status).toBe(200);
      }

      const over = await POST(postRequest(validPayload(), { evaluatorId, ip }));
      expect(over.status).toBe(429);
    });
  });

  describe("valid submission", () => {
    it("stores the judgment with evaluator_id from the cookie, ignoring a body-supplied one", async () => {
      const response = await POST(
        postRequest(
          validPayload({
            response_a_id: "resp-1b",
            response_b_id: "resp-1a",
            outcome: "b",
            evaluator_id: "client-supplied-fake-id",
          }),
          { evaluatorId, ip: "5.5.5.1" },
        ),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ stored: true, created: true });

      const { judgments } = await voiceStorageRef.current.listAllJudgments();
      expect(judgments).toHaveLength(1);
      const stored = judgments[0];
      expect(stored.evaluator_id).toBe(evaluatorId);
      expect(stored.evaluator_id).not.toBe("client-supplied-fake-id");
      // Display order as sent by the client is preserved verbatim...
      expect(stored.response_a_id).toBe("resp-1b");
      expect(stored.response_b_id).toBe("resp-1a");
      expect(stored.outcome).toBe("b");
      // ...while comparison_id is the canonical (sorted) key.
      expect(stored.comparison_id).toBe(comparisonIdFor("resp-1a", "resp-1b"));
    });

    it("returns 200 with created:true then created:false on a duplicate submit, storing exactly one judgment", async () => {
      const payload = validPayload();

      const first = await POST(postRequest(payload, { evaluatorId, ip: "5.5.5.2" }));
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ stored: true, created: true });

      const second = await POST(postRequest(payload, { evaluatorId, ip: "5.5.5.2" }));
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ stored: true, created: false });

      expect(await storedJudgmentCount()).toBe(1);
    });

    it("stores both_bad + not_sure with no free text", async () => {
      const response = await POST(
        postRequest(
          {
            response_a_id: "resp-1a",
            response_b_id: "resp-1b",
            outcome: "both_bad",
            reason: "not_sure",
            play_counts: { prompt: 0, a: 1, b: 1 },
            time_to_judgment_ms: 2000,
          },
          { evaluatorId, ip: "5.5.5.3" },
        ),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ stored: true, created: true });

      const { judgments } = await voiceStorageRef.current.listAllJudgments();
      const stored = judgments.find((j) => j.evaluator_id === evaluatorId)!;
      expect(stored.outcome).toBe("both_bad");
      expect(stored.reason).toBe("not_sure");
      expect(stored.free_text).toBeUndefined();
    });
  });

  describe("storage failure", () => {
    it("returns a 5xx (not success) when storage throws a non-conflict error", async () => {
      vi.spyOn(voiceStorageRef.current, "putJudgment").mockRejectedValueOnce(new Error("blob unavailable"));

      const response = await POST(postRequest(validPayload(), { evaluatorId, ip: "6.6.6.1" }));

      expect(response.status).toBeGreaterThanOrEqual(500);
      const body = await response.json();
      expect(body.stored).not.toBe(true);
      expect(await storedJudgmentCount()).toBe(0);
    });
  });

  describe("not seeded", () => {
    it("returns 409 when no manifest has been seeded", async () => {
      resetVoiceStorage();
      const response = await POST(postRequest(validPayload(), { evaluatorId, ip: "7.7.7.1" }));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "not seeded" });
    });
  });
});
