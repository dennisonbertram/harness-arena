import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleGenerationManifest,
  buildResponseRequest,
  buildSayExactlyRequest,
  buildSpeechRequest,
  fetchWithRetry,
  isValidWavFile,
  parseArgs,
  parseResponseCompletion,
  planWork,
  slugifyModel,
  summarizeByModel,
  validatePromptSet,
  wavStats,
} from "./generate-voice-clips.mjs";

const REQUIRED_CATEGORIES = [
  "factual",
  "short-explanation",
  "emotional",
  "high-energy",
  "sensitive",
  "pronunciation-names",
  "pronunciation-numbers",
  "pronunciation-acronyms",
  "ambiguous",
  "clarification",
  "concise-instruction",
  "storytelling",
];

/** Builds a canonical 44-byte-header mono 16-bit PCM WAV buffer from exact int16 samples, for deterministic RMS math in tests. */
function buildTestWav(samples: number[], sampleRate = 16000): Buffer {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  samples.forEach((s, i) => buf.writeInt16LE(s, 44 + i * 2));
  return buf;
}

// ---------------------------------------------------------------------------
// U1: starter prompt set + validatePromptSet
// ---------------------------------------------------------------------------

describe("scripts/voice-prompts-starter.json", () => {
  const starter = JSON.parse(readFileSync(new URL("./voice-prompts-starter.json", import.meta.url), "utf8"));

  it("has 12 prompts and passes validatePromptSet with no length warnings", () => {
    expect(starter.prompts).toHaveLength(12);
    expect(validatePromptSet(starter)).toEqual({ warnings: [] });
  });

  it("covers every required category at least once", () => {
    const present = new Set(starter.prompts.map((p: { category: string }) => p.category));
    for (const category of REQUIRED_CATEGORIES) {
      expect(present.has(category)).toBe(true);
    }
  });

  it("uses stable kebab-case keys with no duplicates", () => {
    const keys = starter.prompts.map((p: { key: string }) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe("validatePromptSet", () => {
  function validSet() {
    return {
      prompts: [
        { key: "p1", text: "Hello there", category: "factual" },
        { key: "p2", text: "Good morning", category: "factual" },
      ],
    };
  }

  it("accepts a well-formed prompt set with no warnings", () => {
    expect(validatePromptSet(validSet())).toEqual({ warnings: [] });
  });

  it("rejects a non-object / missing prompts[] shape", () => {
    expect(() => validatePromptSet(null)).toThrow(/prompts\[\]/);
    expect(() => validatePromptSet({})).toThrow(/prompts\[\]/);
    expect(() => validatePromptSet("nope")).toThrow(/prompts\[\]/);
  });

  it("throws naming the offending entry for a missing key", () => {
    const set = validSet();
    delete (set.prompts[0] as { key?: string }).key;
    expect(() => validatePromptSet(set)).toThrow(/missing a string "key"/);
  });

  it("throws naming the offending key for a duplicate key", () => {
    const set = validSet();
    set.prompts[1].key = "p1";
    expect(() => validatePromptSet(set)).toThrow(/duplicate prompt key "p1"/);
  });

  it("throws naming the offending key for empty text", () => {
    const set = validSet();
    set.prompts[0].text = "   ";
    expect(() => validatePromptSet(set)).toThrow(/"p1".*text/);
  });

  it("warns (without throwing) on a >60-word text, naming the key", () => {
    const set = validSet();
    set.prompts[0].text = Array.from({ length: 65 }, (_, i) => `word${i}`).join(" ");
    const { warnings } = validatePromptSet(set);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/"p1"/);
  });
});

// ---------------------------------------------------------------------------
// U2: provider clients
// ---------------------------------------------------------------------------

describe("buildResponseRequest", () => {
  it("carries both modalities, wav format, the configured voice, and a <=2-sentence system prompt", () => {
    const body = buildResponseRequest("openai/gpt-audio", "alloy", "What's the weather?");
    expect(body.model).toBe("openai/gpt-audio");
    expect(body.modalities).toEqual(["text", "audio"]);
    expect(body.audio).toEqual({ voice: "alloy", format: "wav" });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toMatch(/two.*sentence/i);
    expect(body.messages[1]).toEqual({ role: "user", content: "What's the weather?" });
  });
});

describe("buildSayExactlyRequest", () => {
  it("embeds the prompt text verbatim under the say-exactly instruction", () => {
    const body = buildSayExactlyRequest("openai/gpt-audio-mini", "nova", "Read this exactly.");
    expect(body.messages[0].content).toBe("Say exactly the following, with natural delivery — nothing else:");
    expect(body.messages[1]).toEqual({ role: "user", content: "Read this exactly." });
    expect(body.audio).toEqual({ voice: "nova", format: "wav" });
    expect(body.modalities).toEqual(["text", "audio"]);
  });
});

describe("buildSpeechRequest", () => {
  it("builds the AI Gateway tts-1 speech body", () => {
    expect(buildSpeechRequest("Hello there", "nova")).toEqual({
      model: "openai/tts-1",
      input: "Hello there",
      voice: "nova",
      response_format: "wav",
    });
  });
});

describe("parseResponseCompletion", () => {
  it("decodes base64 audio to a matching Buffer and prefers audio.transcript", () => {
    const wavBytes = Buffer.from("some wav bytes", "utf8");
    const json = {
      choices: [{ message: { content: "fallback text", audio: { data: wavBytes.toString("base64"), transcript: "Hi there." } } }],
    };
    const { wav, transcript } = parseResponseCompletion(json, { expectedVoice: "alloy" });
    expect(wav.equals(wavBytes)).toBe(true);
    expect(transcript).toBe("Hi there.");
  });

  it("falls back to message.content when audio.transcript is absent", () => {
    const json = { choices: [{ message: { content: "Hi there.", audio: { data: Buffer.from("abc").toString("base64") } } }] };
    expect(parseResponseCompletion(json, { expectedVoice: "alloy" }).transcript).toBe("Hi there.");
  });

  it("throws naming the model and prompt key when no audio is returned (refusal)", () => {
    const json = { choices: [{ message: { content: "I can't help with that." } }] };
    expect(() =>
      parseResponseCompletion(json, { expectedVoice: "alloy", model: "openai/gpt-audio", promptKey: "diagnosis-news" }),
    ).toThrow(/openai\/gpt-audio/);
    expect(() =>
      parseResponseCompletion(json, { expectedVoice: "alloy", model: "openai/gpt-audio", promptKey: "diagnosis-news" }),
    ).toThrow(/diagnosis-news/);
  });

  it("throws naming both voices when the response echoes a different voice than requested", () => {
    const json = { choices: [{ message: { audio: { data: Buffer.from("x").toString("base64"), voice: "verse" } } }] };
    expect(() => parseResponseCompletion(json, { expectedVoice: "alloy" })).toThrow(/alloy/);
    expect(() => parseResponseCompletion(json, { expectedVoice: "alloy" })).toThrow(/verse/);
  });

  it("passes when the response has no voice field at all", () => {
    const json = { choices: [{ message: { audio: { data: Buffer.from("x").toString("base64"), transcript: "hi" } } }] };
    expect(() => parseResponseCompletion(json, { expectedVoice: "alloy" })).not.toThrow();
  });
});

describe("fetchWithRetry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries once on 429 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "rate limited" })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const res = await fetchWithRetry(
      "https://example.test",
      {},
      { attempts: 3, timeoutMs: 1000, fetchImpl: fetchMock, retryDelayMs: 0 },
    );
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails fast on a non-retryable 4xx without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 400, text: async () => "bad request" });
    await expect(
      fetchWithRetry("https://example.test", {}, { attempts: 3, fetchImpl: fetchMock, retryDelayMs: 0 }),
    ).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on network/timeout errors up to the attempt bound, then throws a clear final error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    await expect(
      fetchWithRetry("https://example.test", {}, { attempts: 3, fetchImpl: fetchMock, retryDelayMs: 0 }),
    ).rejects.toThrow(/failed after 3 attempts/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// U3: cache probe, planning, manifest assembly, WAV summary math
// ---------------------------------------------------------------------------

describe("isValidWavFile", () => {
  it("accepts a full valid WAV buffer and rejects a too-short or bad-magic one", () => {
    expect(isValidWavFile(buildTestWav([100, -100, 100, -100]))).toBe(true);
    expect(isValidWavFile(Buffer.alloc(20))).toBe(false);
    const bad = Buffer.alloc(100);
    bad.write("JUNK", 0);
    expect(isValidWavFile(bad)).toBe(false);
  });

  it("probes a real file on disk, and treats missing/empty/corrupt files as invalid", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wav-probe-"));
    try {
      const goodPath = path.join(dir, "good.wav");
      writeFileSync(goodPath, buildTestWav([1, 2, 3, 4]));
      expect(isValidWavFile(goodPath)).toBe(true);

      const emptyPath = path.join(dir, "empty.wav");
      writeFileSync(emptyPath, Buffer.alloc(0));
      expect(isValidWavFile(emptyPath)).toBe(false);

      expect(isValidWavFile(path.join(dir, "missing.wav"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("slugifyModel", () => {
  it("replaces / and . with - for a stable filename/key-safe slug", () => {
    expect(slugifyModel("openai/gpt-audio-mini")).toBe("openai-gpt-audio-mini");
    expect(slugifyModel("openai/gpt-audio-mini.beta")).toBe("openai-gpt-audio-mini-beta");
  });
});

describe("planWork", () => {
  const promptSet = {
    prompts: [
      { key: "p1", text: "one", category: "factual" },
      { key: "p2", text: "two", category: "factual" },
    ],
  };
  const models = ["openai/gpt-audio", "openai/gpt-audio-mini"];

  it("plans every prompt and response when the cache is empty", () => {
    const plan = planWork(promptSet, models, () => false, { outDir: "out" });
    expect(plan.promptJobs).toHaveLength(2);
    expect(plan.responseJobs).toHaveLength(4);
  });

  it("skips entries the cache probe reports valid", () => {
    const validFiles = new Set(["out/prompts/p1.wav", "out/responses/p1__openai-gpt-audio.wav"]);
    const plan = planWork(promptSet, models, (file: string) => validFiles.has(file), { outDir: "out" });
    expect(plan.promptJobs.map((j) => j.promptKey)).toEqual(["p2"]);
    expect(plan.responseJobs).toHaveLength(3);
  });

  it("treats a 0-byte or non-RIFF existing file as missing (regenerated), via the real isValidWavFile probe", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "plan-work-"));
    try {
      mkdirSync(path.join(dir, "prompts"), { recursive: true });
      writeFileSync(path.join(dir, "prompts", "p1.wav"), Buffer.alloc(0));
      const plan = planWork(promptSet, models, (file: string) => isValidWavFile(file), { outDir: dir });
      expect(plan.promptJobs.map((j) => j.promptKey)).toContain("p1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--force plans everything regardless of what the cache probe reports", () => {
    const plan = planWork(promptSet, models, () => true, { outDir: "out", force: true });
    expect(plan.promptJobs).toHaveLength(2);
    expect(plan.responseJobs).toHaveLength(4);
  });

  it("--limit 1 plans only the first prompt's work", () => {
    const plan = planWork(promptSet, models, () => false, { outDir: "out", limit: 1 });
    expect(plan.promptJobs.map((j) => j.promptKey)).toEqual(["p1"]);
    expect(plan.responseJobs.map((j) => j.promptKey)).toEqual(["p1", "p1"]);
  });
});

describe("assembleGenerationManifest", () => {
  const promptSet = {
    prompts: [
      { key: "p1", text: "one", category: "factual" },
      { key: "p2", text: "two", category: "factual" },
    ],
  };
  const models = ["openai/gpt-audio", "openai/gpt-audio-mini"];

  function fullResults() {
    return [
      { type: "prompt", promptKey: "p1", ok: true },
      { type: "prompt", promptKey: "p2", ok: true },
      { type: "response", promptKey: "p1", model: "openai/gpt-audio", ok: true, transcript: "A1" },
      { type: "response", promptKey: "p1", model: "openai/gpt-audio-mini", ok: true, transcript: "A1m" },
      { type: "response", promptKey: "p2", model: "openai/gpt-audio", ok: true, transcript: "A2" },
      { type: "response", promptKey: "p2", model: "openai/gpt-audio-mini", ok: true, transcript: "A2m" },
    ];
  }

  it("builds a manifest with 2 models, 2 prompts, 4 responses, correct keys, outDir-prefixed paths, and transcripts attached", () => {
    const { manifest, warnings } = assembleGenerationManifest(promptSet, models, fullResults(), "voice-dataset");
    expect(warnings).toEqual([]);
    expect(manifest!.models).toEqual([
      { key: "openai-gpt-audio", name: "openai/gpt-audio" },
      { key: "openai-gpt-audio-mini", name: "openai/gpt-audio-mini" },
    ]);
    expect(manifest!.prompts).toHaveLength(2);
    expect(manifest!.prompts[0]).toEqual({ key: "p1", text: "one", category: "factual", file: "voice-dataset/prompts/p1.wav" });
    expect(manifest!.responses).toHaveLength(4);
    expect(manifest!.responses[0]).toEqual({
      prompt: "p1",
      model: "openai-gpt-audio",
      file: "voice-dataset/responses/p1__openai-gpt-audio.wav",
      transcript: "A1",
    });
  });

  it("excludes a prompt missing one model's response, keeps the other prompt intact, and warns", () => {
    const results = fullResults().filter(
      (r) => !(r.type === "response" && r.promptKey === "p1" && r.model === "openai/gpt-audio-mini"),
    );
    const { manifest, warnings } = assembleGenerationManifest(promptSet, models, results, "voice-dataset");
    expect(manifest!.prompts.map((p) => p.key)).toEqual(["p2"]);
    expect(manifest!.responses.map((r) => r.prompt)).toEqual(["p2", "p2"]);
    expect(warnings.some((w) => w.includes('"p1"'))).toBe(true);
  });

  it("returns a refusal marker (manifest: null) when zero prompts have complete coverage", () => {
    const results = fullResults().filter((r) => r.type !== "response");
    const { manifest, warnings } = assembleGenerationManifest(promptSet, models, results, "voice-dataset");
    expect(manifest).toBeNull();
    expect(warnings).toHaveLength(2);
  });

  describe("sidecar transcript lookup for cached (not freshly regenerated) responses", () => {
    // A cached response's result carries ok:true but no transcript -- the
    // generation didn't run this time, so the only source is its .txt sidecar.
    function cachedResults() {
      return [
        { type: "prompt", promptKey: "p1", ok: true },
        { type: "prompt", promptKey: "p2", ok: true },
        { type: "response", promptKey: "p1", model: "openai/gpt-audio", ok: true },
        { type: "response", promptKey: "p1", model: "openai/gpt-audio-mini", ok: true },
        { type: "response", promptKey: "p2", model: "openai/gpt-audio", ok: true },
        { type: "response", promptKey: "p2", model: "openai/gpt-audio-mini", ok: true },
      ];
    }

    it("attaches a transcript read from the response's sidecar .txt file when the result has none", () => {
      const readSidecar = (sidecarPath: string) =>
        sidecarPath === "voice-dataset/responses/p1__openai-gpt-audio.txt" ? "Cached answer text." : undefined;

      const { manifest } = assembleGenerationManifest(promptSet, models, cachedResults(), "voice-dataset", readSidecar);

      const entry = manifest!.responses.find((r) => r.prompt === "p1" && r.model === "openai-gpt-audio");
      expect(entry!.transcript).toBe("Cached answer text.");
    });

    it("omits the transcript key entirely when no sidecar exists for a cached response", () => {
      const { manifest } = assembleGenerationManifest(promptSet, models, cachedResults(), "voice-dataset", () => undefined);
      const serialized = JSON.parse(JSON.stringify(manifest));

      const entry = serialized.responses.find((r: { prompt: string; model: string }) => r.prompt === "p1" && r.model === "openai-gpt-audio");
      expect(entry).not.toHaveProperty("transcript");
    });
  });
});

describe("wavStats", () => {
  it("computes RMS dB and duration from a known-amplitude PCM buffer", () => {
    const amplitude = 16384;
    const sampleRate = 16000;
    const numSamples = 8000; // 0.5s, alternating +/-amplitude
    const samples = Array.from({ length: numSamples }, (_, i) => (i % 2 === 0 ? amplitude : -amplitude));
    const wav = buildTestWav(samples, sampleRate);

    const { durationSeconds, rmsDb } = wavStats(wav);
    expect(durationSeconds).toBeCloseTo(0.5, 5);
    expect(rmsDb).toBeCloseTo(20 * Math.log10(amplitude / 32768), 2);
  });
});

describe("summarizeByModel", () => {
  it("flags a >6dB average RMS gap between two models", () => {
    const entries = [
      { model: "model-a", durationSeconds: 1, rmsDb: -10 },
      { model: "model-a", durationSeconds: 1.2, rmsDb: -11 },
      { model: "model-b", durationSeconds: 1, rmsDb: -25 },
    ];
    const { perModel, levelGapFlag } = summarizeByModel(entries);
    expect(perModel.find((m) => m.model === "model-a")!.avgRmsDb).toBeCloseTo(-10.5, 5);
    expect(levelGapFlag).toMatch(/model-a/);
    expect(levelGapFlag).toMatch(/model-b/);
  });

  it("does not flag a gap of 6dB or less", () => {
    const entries = [
      { model: "model-a", durationSeconds: 1, rmsDb: -10 },
      { model: "model-b", durationSeconds: 1, rmsDb: -13 },
    ];
    expect(summarizeByModel(entries).levelGapFlag).toBeNull();
  });
});

describe("parseArgs", () => {
  it("applies defaults when only the prompts path is given", () => {
    expect(parseArgs(["prompts.json"])).toEqual({
      promptsPath: "prompts.json",
      outDir: "voice-dataset",
      models: ["openai/gpt-audio", "openai/gpt-audio-mini"],
      voice: "alloy",
      promptVoice: "nova",
      limit: undefined,
      force: false,
    });
  });

  it("parses --out/--models/--voice/--prompt-voice/--limit/--force overrides", () => {
    const opts = parseArgs([
      "prompts.json",
      "--out",
      "out2",
      "--models",
      "a/b,c/d",
      "--voice",
      "verse",
      "--prompt-voice",
      "shimmer",
      "--limit",
      "3",
      "--force",
    ]);
    expect(opts).toEqual({
      promptsPath: "prompts.json",
      outDir: "out2",
      models: ["a/b", "c/d"],
      voice: "verse",
      promptVoice: "shimmer",
      limit: 3,
      force: true,
    });
  });

  it("throws a usage error when no prompts path is given", () => {
    expect(() => parseArgs(["--force"])).toThrow(/usage/i);
  });
});
