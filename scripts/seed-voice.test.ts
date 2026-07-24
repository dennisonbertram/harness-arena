import { describe, expect, it } from "vitest";
import { assembleManifest, generateToneWav, validateInput } from "./seed-voice.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validInput() {
  return {
    models: [
      { key: "model-alpha", name: "Model Alpha" },
      { key: "model-beta", name: "Model Beta" },
    ],
    prompts: [
      { key: "prompt-1", text: "Hello there", file: "/fixtures/prompt-1.wav" },
      { key: "prompt-2", text: "Good morning", category: "greeting", file: "/fixtures/prompt-2.wav" },
    ],
    responses: [
      { prompt: "prompt-1", model: "model-alpha", file: "/fixtures/prompt-1__model-alpha.wav" },
      { prompt: "prompt-1", model: "model-beta", file: "/fixtures/prompt-1__model-beta.wav" },
      { prompt: "prompt-2", model: "model-alpha", file: "/fixtures/prompt-2__model-alpha.wav" },
      { prompt: "prompt-2", model: "model-beta", file: "/fixtures/prompt-2__model-beta.wav" },
    ],
  };
}

describe("generateToneWav", () => {
  it("produces a valid RIFF/WAVE header with a non-zero data length", () => {
    const wav = generateToneWav({ frequencyHz: 440 });

    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");

    const dataSize = wav.readUInt32LE(40);
    expect(dataSize).toBeGreaterThan(0);
    expect(wav.length).toBe(44 + dataSize);
  });

  it("produces different audio bytes for two different frequencies", () => {
    const a = generateToneWav({ frequencyHz: 300 });
    const b = generateToneWav({ frequencyHz: 900 });

    expect(a.length).toBe(b.length);
    expect(a.equals(b)).toBe(false);
  });
});

describe("validateInput", () => {
  it("accepts a well-formed manifest", () => {
    expect(() => validateInput(validInput())).not.toThrow();
  });

  it("rejects a non-object input", () => {
    expect(() => validateInput(null)).toThrow(/must be a JSON object/);
    expect(() => validateInput("nope")).toThrow(/must be a JSON object/);
  });

  it("rejects an input missing the models/prompts/responses arrays", () => {
    expect(() => validateInput({})).toThrow(/must have models\[\], prompts\[\], responses\[\] arrays/);
  });

  it("rejects a model entry missing a key", () => {
    const input = validInput();
    delete (input.models[0] as { key?: string }).key;

    expect(() => validateInput(input)).toThrow(/model entry missing a string "key"/);
  });

  it("rejects a model entry missing a name", () => {
    const input = validInput();
    delete (input.models[0] as { name?: string }).name;

    expect(() => validateInput(input)).toThrow(/model "model-alpha" missing a string "name"/);
  });

  it("rejects two models sharing a key", () => {
    const input = validInput();
    input.models[1].key = input.models[0].key;

    expect(() => validateInput(input)).toThrow(/duplicate model key "model-alpha"/);
  });

  it("rejects two models sharing a display name, even with different keys", () => {
    const input = validInput();
    input.models[1].name = input.models[0].name;

    expect(() => validateInput(input)).toThrow(/duplicate model name "Model Alpha"/);
  });

  it("rejects a prompt entry missing a key", () => {
    const input = validInput();
    delete (input.prompts[0] as { key?: string }).key;

    expect(() => validateInput(input)).toThrow(/prompt entry missing a string "key"/);
  });

  it("rejects a prompt entry missing a file", () => {
    const input = validInput();
    delete (input.prompts[0] as { file?: string }).file;

    expect(() => validateInput(input)).toThrow(/prompt "prompt-1" missing a string "file"/);
  });

  it("rejects two prompts sharing a key", () => {
    const input = validInput();
    input.prompts[1].key = input.prompts[0].key;

    expect(() => validateInput(input)).toThrow(/duplicate prompt key "prompt-1"/);
  });

  it("rejects a response missing prompt/model/file", () => {
    const input = validInput();
    delete (input.responses[0] as { model?: string }).model;

    expect(() => validateInput(input)).toThrow(/response\[0\] must have "prompt", "model", and "file" strings/);
  });

  it("rejects a response referencing an unknown prompt key, before any upload", () => {
    const input = validInput();
    input.responses[0].prompt = "no-such-prompt";

    expect(() => validateInput(input)).toThrow(/unknown prompt key "no-such-prompt"/);
  });

  it("rejects a response referencing an unknown model key", () => {
    const input = validInput();
    input.responses[0].model = "no-such-model";

    expect(() => validateInput(input)).toThrow(/unknown model key "no-such-model"/);
  });
});

describe("assembleManifest", () => {
  it("builds 4 responses (2 prompts x 2 models) with UUID ids, correct linkage, and UUID-only blob keys", () => {
    const { manifest, counts } = assembleManifest(validInput(), null);

    expect(manifest.version).toBe("1");
    expect(manifest.models).toHaveLength(2);
    expect(manifest.prompts).toHaveLength(2);
    expect(manifest.responses).toHaveLength(4);

    for (const m of manifest.models) expect(m.id).toMatch(UUID_RE);
    for (const p of manifest.prompts) {
      expect(p.id).toMatch(UUID_RE);
      expect(p.audio_url).toBe(`voice/audio/prompts/${p.id}.wav`);
    }

    for (const r of manifest.responses) {
      expect(r.id).toMatch(UUID_RE);
      expect(manifest.prompts.some((p: { id: string }) => p.id === r.prompt_id)).toBe(true);
      expect(manifest.models.some((m: { id: string }) => m.id === r.model_id)).toBe(true);
      expect(r.audio_url).toBe(`voice/audio/responses/${r.id}.wav`);
      // No local file path or model name leaks into what becomes a blob key.
      expect(r.audio_url).not.toMatch(/fixtures|model-alpha|model-beta|\.wav__/);
    }

    expect(counts.models.minted).toBe(2);
    expect(counts.prompts.minted).toBe(2);
    expect(counts.responses.minted).toBe(4);
  });

  it("reuses matching keys from a prior manifest verbatim and mints exactly one new id", () => {
    const priorModel = { key: "model-alpha", id: "11111111-1111-4111-8111-111111111111", name: "Model Alpha" };
    const priorPrompt = {
      key: "prompt-1",
      id: "22222222-2222-4222-8222-222222222222",
      audio_url: "voice/audio/prompts/22222222-2222-4222-8222-222222222222.wav",
    };
    const priorManifestRaw = {
      version: "1",
      created_at: "2026-01-01T00:00:00.000Z",
      models: [priorModel],
      prompts: [priorPrompt],
      responses: [],
    };
    const input = {
      models: [{ key: "model-alpha", name: "Model Alpha" }],
      prompts: [{ key: "prompt-1", file: "/fixtures/prompt-1.wav" }],
      responses: [{ prompt: "prompt-1", model: "model-alpha", file: "/fixtures/prompt-1__model-alpha.wav" }],
    };

    const { manifest, counts } = assembleManifest(input, priorManifestRaw);

    expect(manifest.models[0].id).toBe(priorModel.id);
    expect(manifest.prompts[0].id).toBe(priorPrompt.id);
    expect(manifest.responses[0].id).toMatch(UUID_RE);
    expect(manifest.responses[0].id).not.toBe(priorModel.id);
    expect(manifest.responses[0].id).not.toBe(priorPrompt.id);

    expect(counts.models).toEqual({ reused: 1, minted: 0 });
    expect(counts.prompts).toEqual({ reused: 1, minted: 0, reminted: 0 });
    expect(counts.responses).toEqual({ reused: 0, minted: 1, reminted: 0 });
  });

  it("carries a response's transcript through to the output manifest verbatim, and omits the key when absent", () => {
    const input = validInput();
    (input.responses[0] as { transcript?: string }).transcript = "Hello there, how can I help?";
    // responses[1] has no transcript field -- must not appear in the written JSON at all.

    const { manifest } = assembleManifest(input, null);
    const serialized = JSON.parse(JSON.stringify(manifest));

    expect(serialized.responses[0].transcript).toBe("Hello there, how can I help?");
    expect(serialized.responses[1]).not.toHaveProperty("transcript");
  });

  it("fails input validation before assembling anything, with a clear error", () => {
    const input = validInput();
    input.responses.push({ prompt: "prompt-1", model: "not-a-model", file: "/fixtures/x.wav" });

    expect(() => assembleManifest(input, null)).toThrow(/unknown model key "not-a-model"/);
  });

  describe("content-aware id reuse (audio_sha256)", () => {
    const HASH_A = "a".repeat(64);
    const HASH_B = "b".repeat(64);
    const priorId = "22222222-2222-4222-8222-222222222222";

    function priorManifestWithPrompt(audio_sha256?: string) {
      return {
        version: "1",
        created_at: "2026-01-01T00:00:00.000Z",
        models: [],
        prompts: [
          {
            key: "prompt-1",
            id: priorId,
            audio_url: `voice/audio/prompts/${priorId}.wav`,
            ...(audio_sha256 !== undefined ? { audio_sha256 } : {}),
          },
        ],
        responses: [],
      };
    }

    function inputWithPrompt(file: string) {
      return { models: [], prompts: [{ key: "prompt-1", file }], responses: [] };
    }

    it("reuses the id when both the key and the audio hash match a prior entry", () => {
      const hashesByFile = new Map([["/fixtures/prompt-1.wav", HASH_A]]);

      const { manifest, counts } = assembleManifest(
        inputWithPrompt("/fixtures/prompt-1.wav"),
        priorManifestWithPrompt(HASH_A),
        hashesByFile,
      );

      expect(manifest.prompts[0].id).toBe(priorId);
      expect(manifest.prompts[0].audio_sha256).toBe(HASH_A);
      expect(counts.prompts).toEqual({ reused: 1, minted: 0, reminted: 0 });
    });

    it("mints a new id when the key matches but the audio hash changed", () => {
      const hashesByFile = new Map([["/fixtures/prompt-1-new.wav", HASH_B]]);

      const { manifest, counts } = assembleManifest(
        inputWithPrompt("/fixtures/prompt-1-new.wav"),
        priorManifestWithPrompt(HASH_A),
        hashesByFile,
      );

      expect(manifest.prompts[0].id).toMatch(UUID_RE);
      expect(manifest.prompts[0].id).not.toBe(priorId);
      expect(manifest.prompts[0].audio_sha256).toBe(HASH_B);
      expect(counts.prompts).toEqual({ reused: 0, minted: 0, reminted: 1 });
    });

    it("reuses by key alone when the prior entry predates audio_sha256 (backward compatible)", () => {
      const hashesByFile = new Map([["/fixtures/prompt-1.wav", HASH_B]]); // hash is irrelevant here

      const { manifest, counts } = assembleManifest(
        inputWithPrompt("/fixtures/prompt-1.wav"),
        priorManifestWithPrompt(undefined),
        hashesByFile,
      );

      expect(manifest.prompts[0].id).toBe(priorId);
      expect(manifest.prompts[0].audio_sha256).toBe(HASH_B);
      expect(counts.prompts).toEqual({ reused: 1, minted: 0, reminted: 0 });
    });
  });
});
