#!/usr/bin/env node
// Loads voice-arena prompts + response clips into Blob storage.
//
// Usage:
//   node scripts/seed-voice.mjs path/to/manifest.json
//   node scripts/seed-voice.mjs --fixtures
//
// Input manifest shape (researcher-authored JSON, local audio file paths):
//   {
//     "models":    [{ "key": "gpt-voice", "name": "GPT Voice" }, ...],
//     "prompts":   [{ "key": "greeting", "text"?: "...", "category"?: "...", "file": "audio/greeting.wav" }, ...],
//     "responses": [{ "prompt": "greeting", "model": "gpt-voice", "file": "audio/greeting-gpt.wav", "transcript"?: "..." }, ...]
//   }
//
// `key` values are stable, researcher-chosen strings (not the final blob
// IDs). On every run this script fetches the CURRENT remote
// voice/manifest.json and reuses the UUIDs of any model/prompt/response
// whose key already exists there, minting new UUIDs only for new entries.
// Without this, re-seeding (fixtures -> real clips, adding a prompt) would
// orphan every previously-collected judgment, since judgments reference
// response/prompt IDs. The remote manifest carries a `key` field on each
// entry to make this matching possible; app code reads the manifest through
// VoiceManifestSchema (lib/voice-types.ts), which silently strips `key` as
// an unrecognized field, so it never affects the served app.
//
// Upload keys are UUID-only (voice/audio/prompts/<id>.wav,
// voice/audio/responses/<id>.wav) -- no local file names or model names ever
// become part of a blob path. voice/manifest.json is written LAST, after
// every clip has been uploaded and HEAD-polled until readable, so it acts as
// the commit marker: a manifest that exists always points at readable audio.
//
// ID reuse is also content-aware: every prompt/response entry carries an
// `audio_sha256` (sha256 of its audio file's bytes). A key match only reuses
// the prior UUID when the hash also matches; if the same key now points at
// different audio, a new UUID is minted so old judgments (made against the
// old audio) don't silently merge with new ones -- they become orphans
// instead, which the results page already counts and surfaces. Manifests
// written before this field existed have no `audio_sha256` and are treated
// as unknown, so they still reuse by key alone (backward compatible).
//
// --fixtures generates small distinguishable tone WAVs in-process (no input
// file needed) for two models across a handful of prompts, so /voice is
// exercisable with no real TTS clips.
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { get, put } from "@vercel/blob";

const MANIFEST_PATH = "voice/manifest.json";

function blobKeyFor(kind, id) {
  return kind === "prompt" ? `voice/audio/prompts/${id}.wav` : `voice/audio/responses/${id}.wav`;
}

// ---------------------------------------------------------------------------
// Pure: WAV byte generation
// ---------------------------------------------------------------------------

/**
 * Generates a mono 16-bit PCM WAV buffer containing a pure sine tone.
 * Used by --fixtures to produce clips a human tester can tell apart by ear.
 */
export function generateToneWav({ frequencyHz, durationMs = 1500, sampleRate = 16000 }) {
  const numSamples = Math.round((sampleRate * durationMs) / 1000);
  const bytesPerSample = 2;
  const numChannels = 1;
  const dataSize = numSamples * bytesPerSample * numChannels;
  const byteRate = sampleRate * numChannels * bytesPerSample;
  const blockAlign = numChannels * bytesPerSample;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM format tag
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  const amplitude = 0.3 * 32767;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Short fade in/out so the tone doesn't click at clip boundaries.
    const fade = Math.min(1, i / 200, (numSamples - i) / 200);
    const sample = Math.round(amplitude * fade * Math.sin(2 * Math.PI * frequencyHz * t));
    buffer.writeInt16LE(sample, 44 + i * bytesPerSample);
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Pure: input validation
// ---------------------------------------------------------------------------

/** Throws with a clear message if the input manifest is malformed or has a dangling reference. Must run before any upload. */
export function validateInput(input) {
  if (!input || typeof input !== "object") {
    throw new Error("seed manifest must be a JSON object with models[], prompts[], responses[]");
  }
  const { models, prompts, responses } = input;
  if (!Array.isArray(models) || !Array.isArray(prompts) || !Array.isArray(responses)) {
    throw new Error("seed manifest must have models[], prompts[], responses[] arrays");
  }

  const modelKeys = new Set();
  const modelNames = new Set();
  for (const m of models) {
    if (!m || typeof m.key !== "string" || !m.key) {
      throw new Error(`model entry missing a string "key": ${JSON.stringify(m)}`);
    }
    if (typeof m.name !== "string" || !m.name) {
      throw new Error(`model "${m.key}" missing a string "name"`);
    }
    if (modelKeys.has(m.key)) throw new Error(`duplicate model key "${m.key}"`);
    modelKeys.add(m.key);
    // Duplicate display names would collapse two distinct models into one
    // leaderboard/results row.
    if (modelNames.has(m.name)) throw new Error(`duplicate model name "${m.name}"`);
    modelNames.add(m.name);
  }

  const promptKeys = new Set();
  for (const p of prompts) {
    if (!p || typeof p.key !== "string" || !p.key) {
      throw new Error(`prompt entry missing a string "key": ${JSON.stringify(p)}`);
    }
    if (typeof p.file !== "string" || !p.file) {
      throw new Error(`prompt "${p.key}" missing a string "file"`);
    }
    if (promptKeys.has(p.key)) throw new Error(`duplicate prompt key "${p.key}"`);
    promptKeys.add(p.key);
  }

  responses.forEach((r, i) => {
    if (!r || typeof r.prompt !== "string" || typeof r.model !== "string" || typeof r.file !== "string" || !r.file) {
      throw new Error(`response[${i}] must have "prompt", "model", and "file" strings: ${JSON.stringify(r)}`);
    }
    if (!promptKeys.has(r.prompt)) {
      throw new Error(
        `response[${i}] references unknown prompt key "${r.prompt}" (known prompt keys: ${[...promptKeys].join(", ") || "none"})`,
      );
    }
    if (!modelKeys.has(r.model)) {
      throw new Error(
        `response[${i}] references unknown model key "${r.model}" (known model keys: ${[...modelKeys].join(", ") || "none"})`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Pure: manifest assembly with ID reuse
// ---------------------------------------------------------------------------

function indexByKey(entries) {
  const map = new Map();
  for (const e of entries ?? []) {
    if (e && typeof e.key === "string") map.set(e.key, e);
  }
  return map;
}

/**
 * Decides the UUID for a content-addressed (prompt/response) entry.
 *
 * Reuses the prior id when the stable key matched AND either the prior
 * entry predates the audio_sha256 field (unknown -> treated as a match, for
 * backward compatibility with manifests written before this check existed)
 * or its stored audio_sha256 equals the new file's hash. Otherwise mints a
 * fresh id: either this is a genuinely new entry, or the key is unchanged
 * but the audio behind it changed, in which case reusing the id would merge
 * old judgments (made against the old audio) with new ones.
 */
function resolveAudioId(prior, hash, countsBucket) {
  if (!prior?.id) {
    countsBucket.minted++;
    return randomUUID();
  }
  if (prior.audio_sha256 === undefined || prior.audio_sha256 === hash) {
    countsBucket.reused++;
    return prior.id;
  }
  countsBucket.reminted++;
  return randomUUID();
}

/**
 * Builds the new manifest from the input manifest, reusing UUIDs of any
 * model/prompt/response whose stable key matches an entry in
 * `priorManifestRaw` (the RAW remote voice/manifest.json JSON, read without
 * going through the Zod schema so its `key` fields survive) and minting new
 * UUIDs for everything else. Prompt/response reuse is additionally gated on
 * content -- see resolveAudioId.
 *
 * `hashesByFile` maps each prompt/response input's `file` path to the
 * sha256 hex digest of its audio bytes. Hashing is I/O (reading a file, or
 * for --fixtures, the generated buffer), so it's computed by the caller and
 * passed in here -- this function stays a pure function of its inputs and
 * never touches the filesystem.
 *
 * Returns:
 *   - manifest: the VoiceManifest-shaped object to write last, with
 *     audio_url set to the destination blob KEY (not yet the real URL --
 *     the caller fills that in after upload).
 *   - uploads: [{ id, kind, file, blobPath }] the caller must upload.
 *   - counts: { models: {reused,minted}, prompts/responses: {reused,minted,reminted} }.
 *     "reminted" = same key, but the audio hash changed underneath it.
 */
export function assembleManifest(input, priorManifestRaw, hashesByFile = new Map()) {
  validateInput(input);

  const priorModels = indexByKey(priorManifestRaw?.models);
  const priorPrompts = indexByKey(priorManifestRaw?.prompts);
  const priorResponses = indexByKey(priorManifestRaw?.responses);

  const counts = {
    models: { reused: 0, minted: 0 },
    prompts: { reused: 0, minted: 0, reminted: 0 },
    responses: { reused: 0, minted: 0, reminted: 0 },
  };

  const models = input.models.map((m) => {
    const prior = priorModels.get(m.key);
    if (prior?.id) counts.models.reused++;
    else counts.models.minted++;
    return { id: prior?.id ?? randomUUID(), key: m.key, name: m.name };
  });
  const modelIdByKey = new Map(models.map((m) => [m.key, m.id]));

  const prompts = input.prompts.map((p) => {
    const prior = priorPrompts.get(p.key);
    const hash = hashesByFile.get(p.file);
    const id = resolveAudioId(prior, hash, counts.prompts);
    return {
      id,
      key: p.key,
      text: p.text,
      category: p.category,
      audio_url: blobKeyFor("prompt", id),
      audio_sha256: hash,
      _file: p.file,
    };
  });
  const promptIdByKey = new Map(prompts.map((p) => [p.key, p.id]));

  const responses = input.responses.map((r) => {
    // A response's stable identity is its prompt+model key pair, not a
    // researcher-chosen key of its own.
    const key = `${r.prompt}::${r.model}`;
    const prior = priorResponses.get(key);
    const hash = hashesByFile.get(r.file);
    const id = resolveAudioId(prior, hash, counts.responses);
    return {
      id,
      key,
      prompt_id: promptIdByKey.get(r.prompt),
      model_id: modelIdByKey.get(r.model),
      audio_url: blobKeyFor("response", id),
      audio_sha256: hash,
      transcript: r.transcript,
      _file: r.file,
    };
  });

  const uploads = [
    ...prompts.map((p) => ({ id: p.id, kind: "prompt", file: p._file, blobPath: blobKeyFor("prompt", p.id) })),
    ...responses.map((r) => ({ id: r.id, kind: "response", file: r._file, blobPath: blobKeyFor("response", r.id) })),
  ];

  const manifest = {
    version: "1",
    created_at: new Date().toISOString(),
    models,
    // Strip the local file path -- it must never land in what gets written
    // to voice/manifest.json (only the UUID-keyed audio_url does).
    prompts: prompts.map((p) => stripFile(p)),
    responses: responses.map((r) => stripFile(r)),
  };

  return { manifest, uploads, counts };
}

function stripFile(entry) {
  const copy = { ...entry };
  delete copy._file;
  return copy;
}

// ---------------------------------------------------------------------------
// --fixtures mode: generate tone clips in-process, no input file needed
// ---------------------------------------------------------------------------

const FIXTURE_MODELS = [
  { key: "model-alpha", name: "model-alpha" },
  { key: "model-beta", name: "model-beta" },
];
const FIXTURE_PROMPT_COUNT = 5;
const FIXTURE_BASE_FREQ_HZ = 220;
const FIXTURE_PROMPT_STEP_HZ = 60;
const FIXTURE_MODEL_OFFSET_HZ = { "model-alpha": 0, "model-beta": 180 };

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function buildFixturesInput(tmpDir) {
  const prompts = [];
  const responses = [];
  const hashesByFile = new Map();
  for (let i = 0; i < FIXTURE_PROMPT_COUNT; i++) {
    const key = `fixture-prompt-${i + 1}`;
    const baseFreq = FIXTURE_BASE_FREQ_HZ + i * FIXTURE_PROMPT_STEP_HZ;
    const promptFile = path.join(tmpDir, `${key}.wav`);
    const promptBuf = generateToneWav({ frequencyHz: baseFreq });
    writeFileSync(promptFile, promptBuf);
    hashesByFile.set(promptFile, sha256Hex(promptBuf));
    prompts.push({ key, text: `Fixture prompt ${i + 1}`, category: "fixture", file: promptFile });

    for (const model of FIXTURE_MODELS) {
      const responseFile = path.join(tmpDir, `${key}__${model.key}.wav`);
      const responseBuf = generateToneWav({ frequencyHz: baseFreq + FIXTURE_MODEL_OFFSET_HZ[model.key] });
      writeFileSync(responseFile, responseBuf);
      hashesByFile.set(responseFile, sha256Hex(responseBuf));
      responses.push({ prompt: key, model: model.key, file: responseFile });
    }
  }
  return { input: { models: FIXTURE_MODELS, prompts, responses }, hashesByFile };
}

/** Hashes every prompt/response input file's bytes for a real (non-fixture) manifest. */
function hashInputFiles(input) {
  const hashesByFile = new Map();
  for (const p of input.prompts ?? []) {
    if (typeof p?.file === "string") hashesByFile.set(p.file, sha256Hex(readFileSync(p.file)));
  }
  for (const r of input.responses ?? []) {
    if (typeof r?.file === "string") hashesByFile.set(r.file, sha256Hex(readFileSync(r.file)));
  }
  return hashesByFile;
}

// ---------------------------------------------------------------------------
// I/O shell: fetch prior manifest, upload, HEAD-poll, write manifest last
// ---------------------------------------------------------------------------

async function fetchPriorManifestRaw() {
  // Deliberately NOT lib/voice-storage.ts's getManifest(): that parses
  // through VoiceManifestSchema, which strips the `key` fields ID reuse
  // depends on. Read the raw JSON directly, same style as
  // lib/storage.ts's readJson.
  const result = await get(MANIFEST_PATH, { access: "public" });
  if (!result) return undefined;
  const text = await new Response(result.stream).text();
  return JSON.parse(text);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function headPollUntilReady(url, { attempts = 10, delayMs = 300 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
    } catch {
      // transient -- including a timed-out/aborted request -- retry
    }
    await sleep(delayMs);
  }
  throw new Error(`gave up waiting for ${url} to become readable (HEAD never returned 200 after ${attempts} attempts)`);
}

async function main() {
  const args = process.argv.slice(2);
  const fixtures = args.includes("--fixtures");
  const inputPath = args.find((a) => !a.startsWith("--"));

  let tmpDir;
  let input;
  let fixtureHashes;
  if (fixtures) {
    tmpDir = mkdtempSync(path.join(tmpdir(), "seed-voice-fixtures-"));
    ({ input, hashesByFile: fixtureHashes } = buildFixturesInput(tmpDir));
  } else {
    if (!inputPath) {
      throw new Error("usage: node scripts/seed-voice.mjs <manifest.json> | --fixtures");
    }
    input = JSON.parse(readFileSync(inputPath, "utf8"));
  }

  try {
    // Validate before any network call or upload.
    validateInput(input);

    const hashesByFile = fixtures ? fixtureHashes : hashInputFiles(input);
    const priorManifestRaw = await fetchPriorManifestRaw();
    const { manifest, uploads, counts } = assembleManifest(input, priorManifestRaw, hashesByFile);

    const idToUrl = new Map();
    for (const upload of uploads) {
      const data = readFileSync(upload.file);
      const { url } = await put(upload.blobPath, data, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      idToUrl.set(upload.id, url);
    }

    for (const p of manifest.prompts) p.audio_url = idToUrl.get(p.id) ?? p.audio_url;
    for (const r of manifest.responses) r.audio_url = idToUrl.get(r.id) ?? r.audio_url;

    for (const url of idToUrl.values()) {
      await headPollUntilReady(url);
    }

    // Write last: this is the commit marker. Everything it references is
    // already uploaded and confirmed readable.
    await put(MANIFEST_PATH, JSON.stringify(manifest), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });

    console.log(
      `Seeded voice/manifest.json: ${manifest.models.length} models, ${manifest.prompts.length} prompts, ${manifest.responses.length} responses`,
    );
    console.log(`  models:    ${counts.models.reused} reused, ${counts.models.minted} minted`);
    console.log(
      `  prompts:   ${counts.prompts.reused} reused, ${counts.prompts.minted} minted, ${counts.prompts.reminted} re-minted (audio changed)`,
    );
    console.log(
      `  responses: ${counts.responses.reused} reused, ${counts.responses.minted} minted, ${counts.responses.reminted} re-minted (audio changed)`,
    );
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
