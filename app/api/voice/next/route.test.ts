import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { comparisonIdFor, progress } from "@/lib/voice-session";
import { resetVoiceStorage, voiceStorageRef } from "@/lib/test-support/voice-storage-ref";
import type { VoiceJudgment, VoiceManifest } from "@/lib/voice-types";

vi.mock("@/lib/voice-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voice-storage")>();
  return { ...actual, getVoiceStorage: () => voiceStorageRef.current };
});

import { GET } from "./route";

const MODEL_1 = "model-aurora";
const MODEL_2 = "model-borealis";
const MODEL_3 = "model-cascade";
const MODEL_NAME_1 = "Aurora";
const MODEL_NAME_2 = "Borealis";
const MODEL_NAME_3 = "Cascade";

// prompt-1 has 3 responses (3 comparisons: 1a/1b, 1a/1c, 1b/1c); prompt-2
// has 2 (1 comparison: 2a/2b) -- 4 comparisons total.
function buildManifest(): VoiceManifest {
  return {
    version: "1",
    created_at: "2026-07-01T00:00:00.000Z",
    models: [
      { id: MODEL_1, name: MODEL_NAME_1 },
      { id: MODEL_2, name: MODEL_NAME_2 },
      { id: MODEL_3, name: MODEL_NAME_3 },
    ],
    prompts: [
      {
        id: "prompt-1",
        text: "Say hello to the team.",
        audio_url: "https://blob.example/voice/audio/prompts/prompt-1.wav",
      },
      { id: "prompt-2", audio_url: "https://blob.example/voice/audio/prompts/prompt-2.wav" },
    ],
    responses: [
      {
        id: "resp-1a",
        prompt_id: "prompt-1",
        model_id: MODEL_1,
        audio_url: "https://blob.example/voice/audio/responses/resp-1a.wav",
      },
      {
        id: "resp-1b",
        prompt_id: "prompt-1",
        model_id: MODEL_2,
        audio_url: "https://blob.example/voice/audio/responses/resp-1b.wav",
      },
      {
        id: "resp-1c",
        prompt_id: "prompt-1",
        model_id: MODEL_3,
        audio_url: "https://blob.example/voice/audio/responses/resp-1c.wav",
      },
      {
        id: "resp-2a",
        prompt_id: "prompt-2",
        model_id: MODEL_1,
        audio_url: "https://blob.example/voice/audio/responses/resp-2a.wav",
      },
      {
        id: "resp-2b",
        prompt_id: "prompt-2",
        model_id: MODEL_2,
        audio_url: "https://blob.example/voice/audio/responses/resp-2b.wav",
      },
    ],
  };
}

const ALL_COMPARISON_IDS = [
  comparisonIdFor("resp-1a", "resp-1b"),
  comparisonIdFor("resp-1a", "resp-1c"),
  comparisonIdFor("resp-1b", "resp-1c"),
  comparisonIdFor("resp-2a", "resp-2b"),
];

function getRequest(opts: { evaluatorId?: string; exclude?: string; ip?: string } = {}): NextRequest {
  const url = new URL("http://localhost/api/voice/next");
  if (opts.exclude) url.searchParams.set("exclude", opts.exclude);
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? "1.1.1.1" };
  if (opts.evaluatorId) headers.cookie = `voice_evaluator=${opts.evaluatorId}`;
  return new NextRequest(url, { headers });
}

async function judgeAll(manifest: VoiceManifest, evaluatorId: string): Promise<void> {
  for (const comparisonId of ALL_COMPARISON_IDS) {
    const [a, b] = comparisonId.split("_");
    const responseA = manifest.responses.find((r) => r.id === a)!;
    const judgment: VoiceJudgment = {
      comparison_id: comparisonId,
      evaluator_id: evaluatorId,
      prompt_id: responseA.prompt_id,
      response_a_id: a,
      response_b_id: b,
      outcome: "a",
      play_counts: { prompt: 1, a: 1, b: 1 },
      time_to_judgment_ms: 1000,
      created_at: "2026-07-01T00:00:00.000Z",
    };
    await voiceStorageRef.current.putJudgment(judgment);
  }
}

describe("GET /api/voice/next", () => {
  beforeEach(() => {
    resetVoiceStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("cookie minting", () => {
    it("mints a voice_evaluator cookie when none is present", async () => {
      await voiceStorageRef.current.putManifest(buildManifest());

      const response = await GET(getRequest({ ip: "2.2.2.1" }));

      const cookie = response.cookies.get("voice_evaluator");
      expect(cookie).toBeDefined();
      expect(cookie?.value).toMatch(/^[0-9a-f-]{36}$/);
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.sameSite).toBe("lax");
      expect(cookie?.path).toBe("/");
      expect(cookie?.secure).toBe(true);
      expect(cookie?.maxAge).toBe(31536000);
    });

    it("does not re-mint when a valid cookie is already present", async () => {
      await voiceStorageRef.current.putManifest(buildManifest());
      const existingId = randomUUID();

      const response = await GET(getRequest({ evaluatorId: existingId, ip: "2.2.2.2" }));

      expect(response.cookies.get("voice_evaluator")).toBeUndefined();
    });

    it("re-mints when the cookie value is malformed (not a UUID)", async () => {
      await voiceStorageRef.current.putManifest(buildManifest());

      const response = await GET(getRequest({ evaluatorId: "not-a-uuid", ip: "2.2.2.3" }));

      const cookie = response.cookies.get("voice_evaluator");
      expect(cookie).toBeDefined();
      expect(cookie?.value).not.toBe("not-a-uuid");
      expect(cookie?.value).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe("mint rate limit", () => {
    it("returns 429 on the 31st cookie-less GET from one IP after 30 successful mints", async () => {
      const ip = "9.9.9.1";
      for (let i = 0; i < 30; i++) {
        const response = await GET(getRequest({ ip }));
        expect(response.status).toBe(200);
        expect(response.cookies.get("voice_evaluator")).toBeDefined();
      }

      const over = await GET(getRequest({ ip }));
      expect(over.status).toBe(429);
      const body = await over.json();
      expect(body).toEqual({ error: "too many new evaluator sessions from this IP, try again later" });
      expect(over.cookies.get("voice_evaluator")).toBeUndefined();
    });
  });

  describe("orphaned judgment keys", () => {
    it("does not count judgment keys absent from the current manifest toward progress", async () => {
      const manifest = buildManifest();
      await voiceStorageRef.current.putManifest(manifest);
      const evaluatorId = randomUUID();
      // Simulate a re-seed: keys from a prior manifest's comparison set that
      // no longer exist in the current one.
      const orphan1: VoiceJudgment = {
        comparison_id: "orphan-resp-x_orphan-resp-y",
        evaluator_id: evaluatorId,
        prompt_id: "old-prompt",
        response_a_id: "orphan-resp-x",
        response_b_id: "orphan-resp-y",
        outcome: "a",
        play_counts: { prompt: 1, a: 1, b: 1 },
        time_to_judgment_ms: 1000,
        created_at: "2026-07-01T00:00:00.000Z",
      };
      const orphan2: VoiceJudgment = { ...orphan1, comparison_id: "orphan-resp-z_orphan-resp-w" };
      await voiceStorageRef.current.putJudgment(orphan1);
      await voiceStorageRef.current.putJudgment(orphan2);

      const response = await GET(getRequest({ evaluatorId, ip: "3.3.3.9" }));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.progress.judged).toBe(0);
      expect(body.progress.total).toBe(ALL_COMPARISON_IDS.length);
      expect(body.progress.judged).toBeLessThanOrEqual(body.progress.total);
    });
  });

  describe("seeding state", () => {
    it("returns not_seeded when no manifest exists", async () => {
      const response = await GET(getRequest({ ip: "3.3.3.1" }));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ not_seeded: true });
    });

    it("returns done: true with final progress once every comparison is judged", async () => {
      const manifest = buildManifest();
      await voiceStorageRef.current.putManifest(manifest);
      const evaluatorId = randomUUID();
      await judgeAll(manifest, evaluatorId);

      const response = await GET(getRequest({ evaluatorId, ip: "3.3.3.2" }));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ done: true, progress: progress(manifest, ALL_COMPARISON_IDS.length) });
    });
  });

  describe("blinding", () => {
    it("never includes a model id or model name in the response payload", async () => {
      const manifest = buildManifest();
      await voiceStorageRef.current.putManifest(manifest);

      const response = await GET(getRequest({ ip: "4.4.4.1" }));
      const raw = JSON.stringify(await response.json());

      for (const model of manifest.models) {
        expect(raw).not.toContain(model.id);
        expect(raw).not.toContain(model.name);
      }
    });
  });

  describe("exclude + display order", () => {
    // Excluding 3 of the 4 comparisons leaves exactly resp-2a/resp-2b, so
    // pickNext's index draw is forced regardless of rng and only the
    // flip draw (second rng() call) determines display order.
    const excludeAllButOne = [
      comparisonIdFor("resp-1a", "resp-1b"),
      comparisonIdFor("resp-1a", "resp-1c"),
      comparisonIdFor("resp-1b", "resp-1c"),
    ].join(",");

    it("honors the exclude param, serving the one remaining comparison", async () => {
      const manifest = buildManifest();
      await voiceStorageRef.current.putManifest(manifest);
      vi.spyOn(Math, "random").mockReturnValueOnce(0.1).mockReturnValueOnce(0.1);

      const response = await GET(getRequest({ exclude: excludeAllButOne, ip: "5.5.5.1" }));
      const body = await response.json();

      expect(body.comparisonId).toBe(comparisonIdFor("resp-2a", "resp-2b"));
      expect(body.clipA.responseId).toBe("resp-2a");
      expect(body.clipB.responseId).toBe("resp-2b");
    });

    it("flips display order when the rng draw crosses 0.5", async () => {
      const manifest = buildManifest();
      await voiceStorageRef.current.putManifest(manifest);
      vi.spyOn(Math, "random").mockReturnValueOnce(0.1).mockReturnValueOnce(0.9);

      const response = await GET(getRequest({ exclude: excludeAllButOne, ip: "5.5.5.2" }));
      const body = await response.json();

      // Same comparison, order flipped: response IDs preserved, only which
      // clip (A/B) each is assigned to changes.
      expect(body.comparisonId).toBe(comparisonIdFor("resp-2a", "resp-2b"));
      expect(body.clipA.responseId).toBe("resp-2b");
      expect(body.clipB.responseId).toBe("resp-2a");
    });

    it("includes prompt audio/text and clip audio URLs resolved from the manifest", async () => {
      const manifest = buildManifest();
      await voiceStorageRef.current.putManifest(manifest);
      vi.spyOn(Math, "random").mockReturnValueOnce(0.1).mockReturnValueOnce(0.1);

      const response = await GET(getRequest({ exclude: excludeAllButOne, ip: "5.5.5.3" }));
      const body = await response.json();

      expect(body.prompt).toEqual({
        audioUrl: "/api/voice/audio/prompts/prompt-2",
        text: undefined,
      });
      expect(body.clipA.audioUrl).toBe("/api/voice/audio/responses/resp-2a");
      expect(body.clipB.audioUrl).toBe("/api/voice/audio/responses/resp-2b");
    });
  });
});
