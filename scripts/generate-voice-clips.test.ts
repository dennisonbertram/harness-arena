import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleGenerationManifest,
  buildResponseRequest,
  buildSayExactlyRequest,
  buildSpeechRequest,
  checkModelSlugCollisions,
  checkSayExactlyFidelity,
  checkVoiceSeparation,
  fetchWithRetry,
  generatePromptClip,
  isValidWavFile,
  parseArgs,
  parseSseAudioStream,
  pcmToWav,
  planWork,
  shouldPrintSeedCommand,
  slugifyModel,
  summarizeByModel,
  validatePromptSet,
  wavStats,
} from "./generate-voice-clips.mjs";
import { validateInput } from "./seed-voice.mjs";

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

  it("throws naming the offending key for a missing category", () => {
    const set = validSet();
    delete (set.prompts[0] as { category?: string }).category;
    expect(() => validatePromptSet(set)).toThrow(/"p1".*category/);
  });

  it("throws naming the offending key for an empty category", () => {
    const set = validSet();
    set.prompts[0].category = "";
    expect(() => validatePromptSet(set)).toThrow(/"p1".*category/);
  });
});

// ---------------------------------------------------------------------------
// U2: provider clients
// ---------------------------------------------------------------------------

describe("buildResponseRequest", () => {
  it("carries stream:true, both modalities, pcm16 format, the configured voice, and a <=2-sentence system prompt", () => {
    const body = buildResponseRequest("openai/gpt-audio", "alloy", "What's the weather?");
    expect(body.model).toBe("openai/gpt-audio");
    expect(body.stream).toBe(true);
    expect(body.modalities).toEqual(["text", "audio"]);
    expect(body.audio).toEqual({ voice: "alloy", format: "pcm16" });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toMatch(/two.*sentence/i);
    expect(body.messages[1]).toEqual({ role: "user", content: "What's the weather?" });
  });
});

describe("buildSayExactlyRequest", () => {
  it("embeds the prompt text verbatim under the say-exactly instruction, streamed as pcm16", () => {
    const body = buildSayExactlyRequest("openai/gpt-audio-mini", "nova", "Read this exactly.");
    expect(body.messages[0].content).toMatch(/text-to-speech engine.*Never answer/s);
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain('verbatim');
    expect(body.messages[1].content).toContain('"Read this exactly."');
    expect(body.stream).toBe(true);
    expect(body.audio).toEqual({ voice: "nova", format: "pcm16" });
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

describe("parseSseAudioStream", () => {
  function sseChunk(delta: Record<string, unknown>) {
    return `data: ${JSON.stringify({ choices: [{ delta }] })}\n`;
  }
  const SSE_DONE = "data: [DONE]\n";

  it("reassembles base64 PCM across multiple chunks into one Buffer, in order", () => {
    const chunkA = Buffer.from([1, 2, 3, 4]);
    const chunkB = Buffer.from([5, 6, 7, 8]);
    const sseText =
      sseChunk({ audio: { data: chunkA.toString("base64") } }) +
      sseChunk({ audio: { data: chunkB.toString("base64") } }) +
      SSE_DONE;

    const { pcm } = parseSseAudioStream(sseText);
    expect(pcm.equals(Buffer.concat([chunkA, chunkB]))).toBe(true);
  });

  it("accumulates an incremental audio.transcript across chunks", () => {
    const sseText =
      sseChunk({ audio: { data: Buffer.from([1]).toString("base64"), transcript: "Hi " } }) +
      sseChunk({ audio: { data: Buffer.from([2]).toString("base64"), transcript: "there!" } }) +
      SSE_DONE;

    expect(parseSseAudioStream(sseText).transcript).toBe("Hi there!");
  });

  it("falls back to accumulated delta.content when no chunk carries an audio transcript", () => {
    const sseText =
      sseChunk({ content: "Hi " }) +
      sseChunk({ audio: { data: Buffer.from([1]).toString("base64") } }) +
      sseChunk({ content: "there!" }) +
      SSE_DONE;

    expect(parseSseAudioStream(sseText).transcript).toBe("Hi there!");
  });

  it("ignores unparseable lines instead of failing the whole stream", () => {
    const sseText = "data: not json at all\n" + sseChunk({ audio: { data: Buffer.from([9]).toString("base64") } }) + SSE_DONE;
    expect(parseSseAudioStream(sseText).pcm.equals(Buffer.from([9]))).toBe(true);
  });

  it("throws naming the model and prompt key when the stream yields zero audio bytes (refusal/text-only)", () => {
    const sseText = sseChunk({ content: "I can't help with that." }) + SSE_DONE;
    expect(() => parseSseAudioStream(sseText, { model: "openai/gpt-audio", promptKey: "diagnosis-news" })).toThrow(
      /openai\/gpt-audio/,
    );
    expect(() => parseSseAudioStream(sseText, { model: "openai/gpt-audio", promptKey: "diagnosis-news" })).toThrow(
      /diagnosis-news/,
    );
  });

  it("throws naming both voices when a chunk echoes a different voice than requested", () => {
    const sseText = sseChunk({ audio: { data: Buffer.from([1]).toString("base64"), voice: "verse" } }) + SSE_DONE;
    expect(() => parseSseAudioStream(sseText, { expectedVoice: "alloy" })).toThrow(/alloy/);
    expect(() => parseSseAudioStream(sseText, { expectedVoice: "alloy" })).toThrow(/verse/);
  });

  it("passes when no chunk carries a voice field at all", () => {
    const sseText = sseChunk({ audio: { data: Buffer.from([1]).toString("base64"), transcript: "hi" } }) + SSE_DONE;
    expect(() => parseSseAudioStream(sseText, { expectedVoice: "alloy" })).not.toThrow();
  });

  it("throws when a chunk carries an error field after an audio chunk, naming the model and prompt key", () => {
    const sseText =
      sseChunk({ audio: { data: Buffer.from([1]).toString("base64") } }) +
      `data: ${JSON.stringify({ error: { message: "content policy violation" } })}\n` +
      SSE_DONE;
    expect(() => parseSseAudioStream(sseText, { model: "openai/gpt-audio", promptKey: "diagnosis-news" })).toThrow(
      /content policy violation/,
    );
    expect(() => parseSseAudioStream(sseText, { model: "openai/gpt-audio", promptKey: "diagnosis-news" })).toThrow(
      /openai\/gpt-audio/,
    );
  });

  it("throws when the stream ends without a [DONE] terminator, naming what was received", () => {
    const sseText = sseChunk({ audio: { data: Buffer.from([1]).toString("base64") } }); // no SSE_DONE -- dropped mid-stream
    expect(() => parseSseAudioStream(sseText)).toThrow(/\[DONE\]/);
  });

  it("still passes for a well-terminated stream", () => {
    const sseText = sseChunk({ audio: { data: Buffer.from([1]).toString("base64"), transcript: "hi" } }) + SSE_DONE;
    expect(() => parseSseAudioStream(sseText)).not.toThrow();
  });
});

describe("pcmToWav", () => {
  it("wraps PCM16 samples in a correct RIFF/WAVE header: magic, chunk sizes, sample rate, byteRate, blockAlign", () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]); // 4 int16 samples
    const wav = pcmToWav(pcm, { sampleRate: 24000, channels: 1 });

    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length); // RIFF chunk size
    expect(wav.readUInt32LE(40)).toBe(pcm.length); // data chunk size
    expect(wav.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav.readUInt32LE(28)).toBe(24000 * 1 * 2); // byte rate
    expect(wav.readUInt16LE(32)).toBe(1 * 2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.length).toBe(44 + pcm.length);
  });

  it("round-trips through wavStats to the expected duration/RMS for a synthetic tone", () => {
    const sampleRate = 24000;
    const amplitude = 8192;
    const numSamples = 12000; // 0.5s, alternating +/-amplitude
    const pcm = Buffer.alloc(numSamples * 2);
    for (let i = 0; i < numSamples; i++) pcm.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
    const wav = pcmToWav(pcm, { sampleRate });

    const { durationSeconds, rmsDb } = wavStats(wav);
    expect(durationSeconds).toBeCloseTo(0.5, 5);
    expect(rmsDb).toBeCloseTo(20 * Math.log10(amplitude / 32768), 2);
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

  it("retries when readBody (res.text()/arrayBuffer()) fails mid-transfer, then succeeds", async () => {
    let readAttempts = 0;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => {
        readAttempts++;
        if (readAttempts === 1) throw new Error("stream reset");
        return "second-attempt body";
      },
    });
    const result = await fetchWithRetry(
      "https://example.test",
      {},
      { attempts: 3, fetchImpl: fetchMock, retryDelayMs: 0, readBody: (res: { text: () => Promise<string> }) => res.text() },
    );
    expect(result).toBe("second-attempt body");
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  describe("full-set coverage independent of a --limit window", () => {
    // Simulates what main() builds: p1/p2 are this run's --limit window
    // (freshly generated), p3 is OUTSIDE the window -- its ok/false comes
    // straight from a cache probe, never from an actual generation this run.
    const promptSet3 = {
      prompts: [
        { key: "p1", text: "one", category: "factual" },
        { key: "p2", text: "two", category: "factual" },
        { key: "p3", text: "three", category: "factual" },
      ],
    };

    function windowResults() {
      return [
        { type: "prompt", promptKey: "p1", ok: true },
        { type: "response", promptKey: "p1", model: "openai/gpt-audio", ok: true, transcript: "A1" },
        { type: "response", promptKey: "p1", model: "openai/gpt-audio-mini", ok: true, transcript: "A1m" },
        { type: "prompt", promptKey: "p2", ok: true },
        { type: "response", promptKey: "p2", model: "openai/gpt-audio", ok: true, transcript: "A2" },
        { type: "response", promptKey: "p2", model: "openai/gpt-audio-mini", ok: true, transcript: "A2m" },
      ];
    }

    it("a limited run's manifest still covers a prompt outside the window when the cache probe reports it complete", () => {
      const results = [
        ...windowResults(),
        { type: "prompt", promptKey: "p3", ok: true },
        { type: "response", promptKey: "p3", model: "openai/gpt-audio", ok: true },
        { type: "response", promptKey: "p3", model: "openai/gpt-audio-mini", ok: true },
      ];
      const { manifest, fullCoverage } = assembleGenerationManifest(promptSet3, models, results, "voice-dataset");
      expect(manifest!.prompts.map((p) => p.key)).toEqual(["p1", "p2", "p3"]);
      expect(fullCoverage).toBe(true);
      expect(shouldPrintSeedCommand(fullCoverage, 0)).toBe(true);
    });

    it("excludes an out-of-window prompt the cache probe reports incomplete, and the seed-command decision comes out false", () => {
      const results = [
        ...windowResults(),
        { type: "prompt", promptKey: "p3", ok: true },
        { type: "response", promptKey: "p3", model: "openai/gpt-audio", ok: true },
        { type: "response", promptKey: "p3", model: "openai/gpt-audio-mini", ok: false }, // not cached -- incomplete
      ];
      const { manifest, warnings, fullCoverage } = assembleGenerationManifest(promptSet3, models, results, "voice-dataset");
      expect(manifest!.prompts.map((p) => p.key)).toEqual(["p1", "p2"]);
      expect(warnings.some((w) => w.includes('"p3"'))).toBe(true);
      expect(fullCoverage).toBe(false);
      expect(shouldPrintSeedCommand(fullCoverage, 0)).toBe(false);
    });
  });
});

describe("shouldPrintSeedCommand", () => {
  it("is true only when coverage is full and nothing failed this run", () => {
    expect(shouldPrintSeedCommand(true, 0)).toBe(true);
    expect(shouldPrintSeedCommand(true, 1)).toBe(false);
    expect(shouldPrintSeedCommand(false, 0)).toBe(false);
    expect(shouldPrintSeedCommand(false, 2)).toBe(false);
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
    const { perModel, levelGapFlags } = summarizeByModel(entries);
    expect(perModel.find((m) => m.model === "model-a")!.avgRmsDb).toBeCloseTo(-10.5, 5);
    expect(levelGapFlags).toHaveLength(1);
    expect(levelGapFlags[0]).toMatch(/model-a/);
    expect(levelGapFlags[0]).toMatch(/model-b/);
  });

  it("does not flag a gap of 6dB or less", () => {
    const entries = [
      { model: "model-a", durationSeconds: 1, rmsDb: -10 },
      { model: "model-b", durationSeconds: 1, rmsDb: -13 },
    ];
    expect(summarizeByModel(entries).levelGapFlags).toEqual([]);
  });

  it("collects a gap flag for every offending pair, not just the last one found", () => {
    const entries = [
      { model: "a", durationSeconds: 1, rmsDb: 0 },
      { model: "b", durationSeconds: 1, rmsDb: -10 },
      { model: "c", durationSeconds: 1, rmsDb: -20 },
    ];
    // a-b gap=10, a-c gap=20, b-c gap=10 -- all three pairs exceed 6dB.
    expect(summarizeByModel(entries).levelGapFlags).toHaveLength(3);
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

  it("throws when fewer than 2 models are resolved", () => {
    expect(() => parseArgs(["prompts.json", "--models", "openai/gpt-audio"])).toThrow(/usage/i);
  });

  it("throws when models resolve to fewer than 2 after whitespace-only entries are filtered", () => {
    expect(() => parseArgs(["prompts.json", "--models", "openai/gpt-audio, ,"])).toThrow(/usage/i);
  });

  it("throws when two model ids slug-collide", () => {
    expect(() => parseArgs(["prompts.json", "--models", "openai/gpt.audio,openai/gpt-audio"])).toThrow(/slugify/i);
  });

  it("throws when --limit is not a positive integer", () => {
    expect(() => parseArgs(["prompts.json", "--limit", "0"])).toThrow(/usage/i);
    expect(() => parseArgs(["prompts.json", "--limit", "-3"])).toThrow(/usage/i);
    expect(() => parseArgs(["prompts.json", "--limit", "1.5"])).toThrow(/usage/i);
    expect(() => parseArgs(["prompts.json", "--limit", "abc"])).toThrow(/usage/i);
  });
});

describe("checkModelSlugCollisions", () => {
  it("throws naming both colliding model ids", () => {
    expect(() => checkModelSlugCollisions(["openai/gpt.audio", "openai/gpt-audio"])).toThrow(/openai\/gpt\.audio/);
    expect(() => checkModelSlugCollisions(["openai/gpt.audio", "openai/gpt-audio"])).toThrow(/openai\/gpt-audio/);
  });

  it("does not throw for models with distinct slugs", () => {
    expect(() => checkModelSlugCollisions(["openai/gpt-audio", "openai/gpt-audio-mini"])).not.toThrow();
  });
});

describe("checkVoiceSeparation", () => {
  it("warns naming the voice when --voice equals --prompt-voice", () => {
    expect(checkVoiceSeparation("alloy", "alloy")).toMatch(/alloy/);
  });

  it("returns null when the voices differ", () => {
    expect(checkVoiceSeparation("alloy", "nova")).toBeNull();
  });
});

describe("checkSayExactlyFidelity", () => {
  it("returns null for a faithful verbatim transcript", () => {
    const text = "What's the tallest mountain in the world?";
    expect(checkSayExactlyFidelity(text, text, "p1")).toBeNull();
  });

  it("flags an empty or wildly divergent (refusal-ish) transcript, naming the prompt key", () => {
    const prompt = "What's the tallest mountain in the world?";
    const empty = checkSayExactlyFidelity(prompt, "", "p1");
    expect(empty).toMatch(/"p1"/);

    const refusal = checkSayExactlyFidelity(prompt, "I can't help with that request.", "p1");
    expect(refusal).toMatch(/"p1"/);
  });

  it("flags an ANSWER-shaped transcript even when it echoes most of the prompt's words (production incident)", () => {
    const prompt = "Hey, quick one — what's the tallest mountain in the world?";
    const answer =
      "Sure, the tallest mountain in the world is Mount Everest, standing at about 8,848 meters, or roughly 29,029 feet above sea level. It's located in the Himalayas, on the border of Nepal and China.";
    const result = checkSayExactlyFidelity(prompt, answer, "tallest-mountain");
    expect(result).toMatch(/ANSWERED/);
    expect(result).toMatch(/"tallest-mountain"/);
  });

  it("flags a paraphrase that stays short but drops too many of the prompt's words", () => {
    const prompt = "Can you walk me through how wifi actually works at home?";
    const paraphrase = "Here is an explanation of wireless networking.";
    expect(checkSayExactlyFidelity(prompt, paraphrase, "how-wifi-works")).toMatch(/covers only/);
  });
});

describe("generatePromptClip (gateway branch WAV validation)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("throws a clear error instead of writing garbage when the gateway returns non-WAV bytes", async () => {
    const badBytes = Buffer.from("not a wav file at all", "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => badBytes.buffer.slice(badBytes.byteOffset, badBytes.byteOffset + badBytes.byteLength),
      }),
    );

    await expect(
      generatePromptClip(
        { promptKey: "p1", text: "hi" },
        { promptVoice: "nova", mode: "gateway", sayExactlyModel: undefined, apiKeys: { gateway: "k" } },
      ),
    ).rejects.toThrow(/invalid|non-wav/i);
  });
});

describe("cross-script contract: assembleGenerationManifest output satisfies seed-voice.mjs's validateInput", () => {
  it("a fully-covered manifest passes seed-voice's own validation", () => {
    const promptSet = { prompts: [{ key: "p1", text: "one", category: "factual" }] };
    const models = ["openai/gpt-audio", "openai/gpt-audio-mini"];
    const results = [
      { type: "prompt", promptKey: "p1", ok: true },
      { type: "response", promptKey: "p1", model: "openai/gpt-audio", ok: true, transcript: "A1" },
      { type: "response", promptKey: "p1", model: "openai/gpt-audio-mini", ok: true, transcript: "A2" },
    ];
    const { manifest } = assembleGenerationManifest(promptSet, models, results, "voice-dataset");
    expect(() => validateInput(manifest!)).not.toThrow();
  });
});
