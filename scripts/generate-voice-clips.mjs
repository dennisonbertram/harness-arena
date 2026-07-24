#!/usr/bin/env node
// Turns a researcher-authored prompt list (scripts/voice-prompts-starter.json
// shape) into a scripts/seed-voice.mjs-ready dataset: one spoken-prompt WAV
// per prompt, plus one spoken-response WAV per prompt x model (the model's
// own answer, rendered as speech).
//
// Usage:
//   node --env-file=.env scripts/generate-voice-clips.mjs <prompts.json> \
//     --out voice-dataset \
//     --models openai/gpt-audio,openai/gpt-audio-mini \
//     --voice alloy --prompt-voice nova \
//     --limit N --force
//
// Env: OPENROUTER_API_KEY (model responses), AI_GATEWAY_API_KEY (tts-1
// prompt audio; falls back to a say-exactly OpenRouter call on failure).
//
// The output directory IS the cache: a re-run skips any prompt/response
// file that already passes isValidWavFile, so an interrupted or partial run
// is cheap to resume. Clips are written to a temp path and renamed on
// success so a crash mid-write can never leave a corrupt file that reads as
// "valid". The manifest only includes prompts with full prompt+model
// coverage; if any clip failed this run, the seed command is withheld (a
// warning tells the researcher to re-run first) and the process exits 1.
//
// Each response WAV has a same-named .txt sidecar (the model's transcript).
// A re-run's manifest reads the sidecar for any response the cache skipped
// regenerating, so re-seeding never drops a transcript from the remote
// manifest (which is fully replaced on every seed).
//
// OpenRouter audio-output chat completions REJECT non-streaming requests
// ("Audio output requires stream: true") and reject wav as a streamed audio
// format ("audio.format does not support 'wav' when stream=true" -- only
// pcm16 is accepted while streaming; verified against the live API).
// Response/say-exactly requests are therefore stream:true + audio.format
// "pcm16": the SSE body is parsed for base64 PCM16 + transcript deltas, and
// the raw PCM is wrapped in a WAV header locally (pcmToWav) before writing
// to disk. ponytail: sample rate is hardcoded to 24000 (empirically
// verified: "Hi there!" -> 36000 PCM bytes = 0.75s at 24kHz mono 16-bit) --
// upgrade to reading a rate from provider response metadata if OpenAI ever
// exposes one.
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GATEWAY_SPEECH_URL = "https://ai-gateway.vercel.sh/v1/audio/speech";

const DEFAULT_MODELS = ["openai/gpt-audio", "openai/gpt-audio-mini"];
const DEFAULT_OUT_DIR = "voice-dataset";
const DEFAULT_VOICE = "alloy";
const DEFAULT_PROMPT_VOICE = "nova";
const JOB_DELAY_MS = 500;

const RESPONSE_SYSTEM_PROMPT =
  "You're a warm, natural-sounding voice assistant. Answer in at most two short spoken sentences, the way you'd talk to someone face to face.";
const SAY_EXACTLY_SYSTEM_PROMPT = "Say exactly the following, with natural delivery — nothing else:";

// ---------------------------------------------------------------------------
// Pure: prompt-set validation
// ---------------------------------------------------------------------------

/**
 * Throws with a clear message naming the offending entry on missing/duplicate
 * key, missing/empty text or category, or an unrecognized top-level shape.
 * Returns { warnings } naming any prompt whose text is long enough (>60
 * words) to likely exceed the ~5-15s spoken clip target -- a warning, not a
 * throw, since a long prompt is still generatable.
 */
export function validatePromptSet(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.prompts)) {
    throw new Error('prompt set must be a JSON object with a prompts[] array: {"prompts": [{key, text, category}]}');
  }

  const keys = new Set();
  const warnings = [];
  input.prompts.forEach((p, i) => {
    if (!p || typeof p.key !== "string" || !p.key) {
      throw new Error(`prompt[${i}] missing a string "key": ${JSON.stringify(p)}`);
    }
    if (keys.has(p.key)) throw new Error(`duplicate prompt key "${p.key}"`);
    keys.add(p.key);
    if (typeof p.text !== "string" || !p.text.trim()) {
      throw new Error(`prompt "${p.key}" missing a non-empty string "text"`);
    }
    if (typeof p.category !== "string" || !p.category) {
      throw new Error(`prompt "${p.key}" missing a string "category"`);
    }
    const wordCount = p.text.trim().split(/\s+/).length;
    if (wordCount > 60) {
      warnings.push(`prompt "${p.key}" is ${wordCount} words -- likely exceeds the ~5-15s spoken clip target`);
    }
  });

  return { warnings };
}

// ---------------------------------------------------------------------------
// Pure: provider request builders
// ---------------------------------------------------------------------------

// OpenRouter audio output requires stream:true, and rejects "wav" as a
// streamed audio.format (pcm16 is the only accepted streamed format) --
// see the header comment.
function buildAudioChatRequest(model, voice, systemContent, userContent) {
  return {
    model,
    stream: true,
    modalities: ["text", "audio"],
    audio: { voice, format: "pcm16" },
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
  };
}

/** OpenRouter chat-completions body (streamed, pcm16): the model answers the prompt as speech. */
export function buildResponseRequest(model, voice, promptText) {
  return buildAudioChatRequest(model, voice, RESPONSE_SYSTEM_PROMPT, promptText);
}

/** Same shape as buildResponseRequest, but instructs the model to speak the text verbatim (prompt-TTS fallback). */
export function buildSayExactlyRequest(model, voice, text) {
  return buildAudioChatRequest(model, voice, SAY_EXACTLY_SYSTEM_PROMPT, text);
}

/** AI Gateway /v1/audio/speech body for tts-1. */
export function buildSpeechRequest(text, voice) {
  return { model: "openai/tts-1", input: text, voice, response_format: "wav" };
}

// ---------------------------------------------------------------------------
// Pure: SSE audio-stream parsing + PCM -> WAV
// ---------------------------------------------------------------------------

/**
 * Parses an OpenRouter streamed chat-completions body ("data: {json}" lines,
 * ending "data: [DONE]") into { pcm: Buffer, transcript }. Each chunk's
 * choices[0].delta.audio.data is a base64 PCM16 segment -- decoded and
 * concatenated in order; delta.audio.transcript is incremental and
 * concatenated the same way, falling back to accumulated delta.content when
 * the stream never carried an audio transcript. Unparseable lines are
 * ignored (skipped, not fatal). Throws clearly (naming model/promptKey when
 * given, and what the model said instead) when the stream yields zero audio
 * bytes -- a refusal or a text-only reply both look like this. Throws naming
 * both voices if any chunk echoes a voice different from expectedVoice; a
 * stream that never carries a voice field passes (observed live behavior).
 */
export function parseSseAudioStream(sseText, { expectedVoice, model, promptKey } = {}) {
  const pcmChunks = [];
  let transcript = "";
  let contentAccum = "";
  let voiceField;

  for (const rawLine of sseText.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "[DONE]") break;

    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue; // ignore unparseable lines
    }
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) continue;

    if (typeof delta.content === "string") contentAccum += delta.content;
    if (delta.audio) {
      if (typeof delta.audio.data === "string" && delta.audio.data) {
        pcmChunks.push(Buffer.from(delta.audio.data, "base64"));
      }
      if (typeof delta.audio.transcript === "string") transcript += delta.audio.transcript;
      if (delta.audio.voice !== undefined) voiceField = delta.audio.voice;
    }
  }

  const pcm = Buffer.concat(pcmChunks);
  if (pcm.length === 0) {
    const context = [model && `model "${model}"`, promptKey && `prompt "${promptKey}"`].filter(Boolean).join(", ");
    throw new Error(
      `no audio in SSE stream${context ? ` (${context})` : ""} -- refusal or text-only reply: ${JSON.stringify(contentAccum || sseText.slice(0, 200))}`,
    );
  }

  if (expectedVoice && voiceField !== undefined && voiceField !== expectedVoice) {
    throw new Error(`voice mismatch: requested "${expectedVoice}" but response audio reports "${voiceField}"`);
  }

  return { pcm, transcript: transcript || contentAccum };
}

/** Wraps raw PCM16 samples in a canonical 44-byte RIFF/WAVE header (mirrors seed-voice.mjs's generateToneWav header math). */
export function pcmToWav(pcmBuffer, { sampleRate = 24000, channels = 1 } = {}) {
  const bytesPerSample = 2;
  const dataSize = pcmBuffer.length;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM format tag
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buffer, 44);
  return buffer;
}

// ---------------------------------------------------------------------------
// I/O: bounded-retry fetch
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch with a per-attempt AbortSignal.timeout deadline. Retries (with
 * linear backoff) on 429, 5xx, and network/timeout errors; fails fast on any
 * other 4xx. Throws a clear error naming the attempt count on final failure.
 */
export async function fetchWithRetry(url, init = {}, opts = {}) {
  const { attempts = 4, timeoutMs = 30000, fetchImpl = fetch, retryDelayMs = 500 } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(retryDelayMs * attempt);
      continue;
    }
    if (res.ok) return res;
    if (res.status !== 429 && res.status < 500) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`${url} failed: HTTP ${res.status}${bodyText ? ` — ${bodyText}` : ""}`);
    }
    lastErr = new Error(`${url} returned HTTP ${res.status}`);
    if (attempt < attempts) await sleep(retryDelayMs * attempt);
  }
  throw new Error(`${url} failed after ${attempts} attempts: ${lastErr?.message ?? lastErr}`);
}

// ---------------------------------------------------------------------------
// Pure/probe: WAV validity
// ---------------------------------------------------------------------------

function looksLikeWav(headerBytes, size) {
  return (
    size > 44 &&
    headerBytes.length >= 12 &&
    headerBytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    headerBytes.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

/**
 * Cache-validity probe: size above the 44-byte WAV header floor AND a
 * RIFF/WAVE magic. Accepts either a file path (reads only the 12-byte
 * header off disk) or an already-loaded Buffer (probed directly, no I/O --
 * used by tests with synthetic WAVs).
 */
export function isValidWavFile(pathOrBuffer) {
  if (Buffer.isBuffer(pathOrBuffer)) {
    return looksLikeWav(pathOrBuffer, pathOrBuffer.length);
  }
  let stat;
  try {
    stat = statSync(pathOrBuffer);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const fd = openSync(pathOrBuffer, "r");
  try {
    const header = Buffer.alloc(12);
    readSync(fd, header, 0, 12, 0);
    return looksLikeWav(header, stat.size);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Pure: WAV PCM summary math
// ---------------------------------------------------------------------------

// ponytail: assumes mono 16-bit PCM (matches tts-1/gpt-audio output) --
// upgrade to read numChannels from the fmt chunk if a stereo source ever
// shows up (duration would currently read ~2x too long for stereo).
export function wavStats(buffer) {
  if (buffer.subarray(0, 4).toString("ascii") !== "RIFF" || buffer.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw new Error("wavStats: not a RIFF/WAVE buffer");
  }
  let offset = 12;
  let sampleRate;
  let dataStart;
  let dataSize;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;
    if (chunkId === "fmt ") {
      sampleRate = buffer.readUInt32LE(chunkDataStart + 4);
    } else if (chunkId === "data") {
      dataStart = chunkDataStart;
      dataSize = chunkSize;
    }
    if (dataStart !== undefined && sampleRate !== undefined) break;
    offset = chunkDataStart + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  if (sampleRate === undefined || dataStart === undefined) {
    throw new Error("wavStats: missing fmt or data chunk");
  }

  const numSamples = Math.floor(dataSize / 2);
  let sumSquares = 0;
  for (let i = 0; i < numSamples; i++) {
    const sample = buffer.readInt16LE(dataStart + i * 2) / 32768;
    sumSquares += sample * sample;
  }
  const rms = numSamples > 0 ? Math.sqrt(sumSquares / numSamples) : 0;
  return {
    durationSeconds: sampleRate > 0 ? numSamples / sampleRate : 0,
    rmsDb: 20 * Math.log10(rms),
  };
}

/**
 * Averages { durationSeconds, rmsDb } per model and flags a >6dB average RMS
 * gap between any two models (the PRD's loudness confound stays visible
 * until normalization lands).
 */
export function summarizeByModel(entries) {
  const byModel = new Map();
  for (const e of entries) {
    if (!byModel.has(e.model)) byModel.set(e.model, []);
    byModel.get(e.model).push(e);
  }
  const perModel = [...byModel.entries()].map(([model, stats]) => ({
    model,
    avgDurationSeconds: stats.reduce((a, s) => a + s.durationSeconds, 0) / stats.length,
    avgRmsDb: stats.reduce((a, s) => a + s.rmsDb, 0) / stats.length,
    count: stats.length,
  }));

  let levelGapFlag = null;
  for (let i = 0; i < perModel.length; i++) {
    for (let j = i + 1; j < perModel.length; j++) {
      const gap = Math.abs(perModel[i].avgRmsDb - perModel[j].avgRmsDb);
      if (gap > 6) {
        levelGapFlag = `level gap: "${perModel[i].model}" vs "${perModel[j].model}" differ by ${gap.toFixed(1)} dB (>6 dB)`;
      }
    }
  }
  return { perModel, levelGapFlag };
}

// ---------------------------------------------------------------------------
// Pure: model-id slugging + output paths
// ---------------------------------------------------------------------------

/** "openai/gpt-audio-mini" -> "openai-gpt-audio-mini" -- stable, filename/key-safe. */
export function slugifyModel(modelId) {
  return modelId.replace(/[/.]/g, "-");
}

function promptFilePath(outDir, key) {
  return `${outDir}/prompts/${key}.wav`;
}
function responseFilePath(outDir, promptKey, modelSlug) {
  return `${outDir}/responses/${promptKey}__${modelSlug}.wav`;
}
// Sidecar transcript for a response clip -- written alongside the WAV so a
// cache-hit (skipped regeneration) on a later run still has its transcript
// available for the manifest, instead of silently dropping it (a re-seed
// fully replaces the remote manifest, so a dropped transcript here is real
// data loss, not just a this-run gap).
function responseSidecarPath(outDir, promptKey, modelSlug) {
  return `${outDir}/responses/${promptKey}__${modelSlug}.txt`;
}

/** Real (I/O) sidecar reader: missing/unreadable file -> undefined, same as "no transcript". */
function defaultSidecarReader(filePath) {
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch {
    return undefined;
  }
}

function applyLimit(prompts, limit) {
  return limit != null ? prompts.slice(0, limit) : prompts;
}

// ---------------------------------------------------------------------------
// Pure: work planning
// ---------------------------------------------------------------------------

/**
 * Lists the prompt-audio and per-model response clips that still need
 * generating: a cached entry (cacheProbe(file) === true) is skipped unless
 * force is set; { limit } caps how many prompts (in file order) are
 * considered at all.
 * @param {{ outDir?: string, force?: boolean, limit?: number }} [options]
 */
export function planWork(promptSet, models, cacheProbe, options = {}) {
  const { outDir = DEFAULT_OUT_DIR, force = false, limit } = options;
  const prompts = applyLimit(promptSet.prompts, limit);
  const promptJobs = [];
  const responseJobs = [];

  for (const p of prompts) {
    const file = promptFilePath(outDir, p.key);
    if (force || !cacheProbe(file)) {
      promptJobs.push({ type: "prompt", promptKey: p.key, text: p.text, file });
    }
    for (const model of models) {
      const slug = slugifyModel(model);
      const respFile = responseFilePath(outDir, p.key, slug);
      if (force || !cacheProbe(respFile)) {
        responseJobs.push({ type: "response", promptKey: p.key, text: p.text, model, file: respFile });
      }
    }
  }

  return { promptJobs, responseJobs };
}

// ---------------------------------------------------------------------------
// Pure: manifest assembly (seed-voice.mjs input format)
// ---------------------------------------------------------------------------

/**
 * Builds a scripts/seed-voice.mjs-compatible input manifest from generation
 * results. `results` entries: { type: "prompt"|"response", promptKey,
 * model?, ok, transcript? }. A prompt is included only when its own audio
 * AND every configured model's response are ok=true; incomplete prompts are
 * excluded and listed in `warnings`. Zero complete prompts returns
 * manifest: null (a refusal marker) -- the caller must not write anything.
 *
 * `readSidecar(sidecarPath)` backfills a transcript for a cached response
 * (one whose result carries no transcript because this run didn't
 * regenerate it) from its `.txt` sidecar file; injectable for pure testing,
 * defaults to a real file read. Returns undefined (transcript omitted) when
 * the sidecar is missing or unreadable.
 */
export function assembleGenerationManifest(promptSet, models, results, outDir, readSidecar = defaultSidecarReader) {
  const promptResults = new Map();
  const responseResults = new Map();
  for (const r of results) {
    if (r.type === "prompt") promptResults.set(r.promptKey, r);
    else if (r.type === "response") responseResults.set(`${r.promptKey}::${r.model}`, r);
  }

  const warnings = [];
  const prompts = [];
  const responses = [];

  for (const p of promptSet.prompts) {
    const promptOk = promptResults.get(p.key)?.ok === true;
    const modelResults = models.map((model) => ({ model, res: responseResults.get(`${p.key}::${model}`) }));
    const missing = modelResults.filter(({ res }) => res?.ok !== true).map(({ model }) => model);

    if (!promptOk || missing.length > 0) {
      const reasons = [!promptOk && "prompt audio missing/failed", missing.length > 0 && `missing response(s) from ${missing.join(", ")}`]
        .filter(Boolean)
        .join("; ");
      warnings.push(`prompt "${p.key}" excluded: ${reasons}`);
      continue;
    }

    prompts.push({ key: p.key, text: p.text, category: p.category, file: promptFilePath(outDir, p.key) });
    for (const { model, res } of modelResults) {
      const slug = slugifyModel(model);
      const transcript = res.transcript ?? readSidecar(responseSidecarPath(outDir, p.key, slug));
      responses.push({
        prompt: p.key,
        model: slug,
        file: responseFilePath(outDir, p.key, slug),
        transcript,
      });
    }
  }

  if (prompts.length === 0) {
    return { manifest: null, warnings };
  }

  const modelEntries = models.map((m) => ({ key: slugifyModel(m), name: m }));
  return { manifest: { models: modelEntries, prompts, responses }, warnings };
}

// ---------------------------------------------------------------------------
// I/O: CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const promptsPath = argv.find((a) => !a.startsWith("--"));
  if (!promptsPath) {
    throw new Error(
      "usage: node scripts/generate-voice-clips.mjs <prompts.json> [--out dir] [--models a,b] [--voice v] [--prompt-voice v] [--limit N] [--force]",
    );
  }
  const flagValue = (name) => {
    const idx = argv.indexOf(`--${name}`);
    return idx === -1 ? undefined : argv[idx + 1];
  };
  const modelsRaw = flagValue("models");
  const limitRaw = flagValue("limit");
  return {
    promptsPath,
    outDir: flagValue("out") ?? DEFAULT_OUT_DIR,
    models: modelsRaw
      ? modelsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_MODELS,
    voice: flagValue("voice") ?? DEFAULT_VOICE,
    promptVoice: flagValue("prompt-voice") ?? DEFAULT_PROMPT_VOICE,
    limit: limitRaw !== undefined ? Number(limitRaw) : undefined,
    force: argv.includes("--force"),
  };
}

/** Temp-write then rename (WAV Buffer or transcript sidecar string) so a crash mid-write can't leave a corrupt/partial file at the final path. */
function writeFileAtomic(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, filePath);
}

async function callGatewaySpeech(text, voice, apiKey) {
  const res = await fetchWithRetry(
    GATEWAY_SPEECH_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildSpeechRequest(text, voice)),
    },
    { attempts: 4, timeoutMs: 30000 },
  );
  return Buffer.from(await res.arrayBuffer());
}

/** POSTs a streamed (stream:true) audio chat-completions body and returns the raw SSE response text -- see parseSseAudioStream. */
async function callOpenRouterChatStream(body, apiKey) {
  const res = await fetchWithRetry(
    OPENROUTER_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    { attempts: 4, timeoutMs: 60000 },
  );
  return res.text();
}

async function generatePromptClip(job, { promptVoice, mode, sayExactlyModel, apiKeys }) {
  if (mode === "gateway") {
    const wav = await callGatewaySpeech(job.text, promptVoice, apiKeys.gateway);
    return { wav, transcript: job.text };
  }
  const sseText = await callOpenRouterChatStream(buildSayExactlyRequest(sayExactlyModel, promptVoice, job.text), apiKeys.openrouter);
  const { pcm, transcript } = parseSseAudioStream(sseText, { expectedVoice: promptVoice, model: sayExactlyModel, promptKey: job.promptKey });
  return { wav: pcmToWav(pcm), transcript };
}

async function generateResponseClip(job, { voice, apiKeys }) {
  const sseText = await callOpenRouterChatStream(buildResponseRequest(job.model, voice, job.text), apiKeys.openrouter);
  const { pcm, transcript } = parseSseAudioStream(sseText, { expectedVoice: voice, model: job.model, promptKey: job.promptKey });
  return { wav: pcmToWav(pcm), transcript };
}

export async function main(argv = process.argv.slice(2)) {
  const { promptsPath, outDir, models, voice, promptVoice, limit, force } = parseArgs(argv);

  const promptSetRaw = JSON.parse(readFileSync(promptsPath, "utf8"));
  const { warnings: lengthWarnings } = validatePromptSet(promptSetRaw);
  for (const w of lengthWarnings) console.warn(`[warn] ${w}`);

  const activePrompts = applyLimit(promptSetRaw.prompts, limit);
  const activePromptSet = { prompts: activePrompts };

  const plan = planWork(activePromptSet, models, (file) => isValidWavFile(file), { outDir, force, limit: undefined });

  const apiKeys = { openrouter: process.env.OPENROUTER_API_KEY, gateway: process.env.AI_GATEWAY_API_KEY };
  if (plan.responseJobs.length > 0 && !apiKeys.openrouter) {
    throw new Error("OPENROUTER_API_KEY is required to generate model responses");
  }
  if (plan.promptJobs.length > 0 && !apiKeys.gateway && !apiKeys.openrouter) {
    throw new Error("AI_GATEWAY_API_KEY (or OPENROUTER_API_KEY, for the say-exactly fallback) is required to generate prompt audio");
  }

  // Seed results with everything the plan did NOT include -- i.e. clips
  // already cached-valid from a prior run -- so the manifest reflects full
  // dataset coverage, not just this run's work.
  const results = [];
  let skippedCached = 0;
  for (const p of activePrompts) {
    if (!plan.promptJobs.some((j) => j.promptKey === p.key)) {
      results.push({ type: "prompt", promptKey: p.key, ok: true });
      skippedCached++;
    }
    for (const model of models) {
      if (!plan.responseJobs.some((j) => j.promptKey === p.key && j.model === model)) {
        results.push({ type: "response", promptKey: p.key, model, ok: true });
        skippedCached++;
      }
    }
  }

  let generated = 0;
  let failed = 0;
  let isFirstJob = true;
  const throttle = async () => {
    if (!isFirstJob) await sleep(JOB_DELAY_MS);
    isFirstJob = false;
  };

  const sayExactlyModel = models[1] ?? models[0];
  let promptMode = "gateway";
  let gatewayAttempted = false;
  for (const job of plan.promptJobs) {
    await throttle();
    try {
      let outcome;
      if (promptMode === "gateway" && !gatewayAttempted) {
        gatewayAttempted = true;
        try {
          outcome = await generatePromptClip(job, { promptVoice, mode: "gateway", apiKeys });
        } catch (err) {
          console.error(
            `LOUD WARNING: AI Gateway tts-1 failed ("${err.message}") -- falling back to say-exactly via ${sayExactlyModel} for ALL prompt clips this run.`,
          );
          promptMode = "say-exactly";
          outcome = await generatePromptClip(job, { promptVoice, mode: "say-exactly", sayExactlyModel, apiKeys });
        }
      } else {
        outcome = await generatePromptClip(job, { promptVoice, mode: promptMode, sayExactlyModel, apiKeys });
      }
      writeFileAtomic(job.file, outcome.wav);
      results.push({ type: "prompt", promptKey: job.promptKey, ok: true, transcript: outcome.transcript });
      generated++;
    } catch (err) {
      console.error(`prompt "${job.promptKey}" failed: ${err.message}`);
      results.push({ type: "prompt", promptKey: job.promptKey, ok: false, error: err.message });
      failed++;
    }
  }

  for (const job of plan.responseJobs) {
    await throttle();
    try {
      const outcome = await generateResponseClip(job, { voice, apiKeys });
      writeFileAtomic(job.file, outcome.wav);
      writeFileAtomic(responseSidecarPath(outDir, job.promptKey, slugifyModel(job.model)), outcome.transcript ?? "");
      results.push({ type: "response", promptKey: job.promptKey, model: job.model, ok: true, transcript: outcome.transcript, wav: outcome.wav });
      generated++;
    } catch (err) {
      console.error(`response "${job.promptKey}" x "${job.model}" failed: ${err.message}`);
      results.push({ type: "response", promptKey: job.promptKey, model: job.model, ok: false, error: err.message });
      failed++;
    }
  }

  const { manifest, warnings: exclusionWarnings } = assembleGenerationManifest(activePromptSet, models, results, outDir);
  for (const w of exclusionWarnings) console.warn(`[warn] ${w}`);

  if (!manifest) {
    throw new Error("zero prompts have complete prompt+model coverage; no manifest written (see warnings above)");
  }

  mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\ngenerated: ${generated}, skipped (cached): ${skippedCached}, failed: ${failed}`);
  console.log(`manifest: ${manifest.prompts.length} prompts, ${manifest.responses.length} responses -> ${manifestPath}`);

  const responseStats = results
    .filter((r) => r.type === "response" && r.ok && r.wav)
    .map((r) => ({ model: r.model, ...wavStats(r.wav) }));
  if (responseStats.length > 0) {
    const { perModel, levelGapFlag } = summarizeByModel(responseStats);
    for (const m of perModel) {
      console.log(`  ${m.model}: avg ${m.avgDurationSeconds.toFixed(1)}s, ${m.avgRmsDb.toFixed(1)} dBFS (n=${m.count})`);
    }
    if (levelGapFlag) console.warn(`[warn] ${levelGapFlag}`);
  }

  if (failed > 0) {
    console.warn(`\n${failed} clip(s) failed this run -- re-run to fill the gaps (cache makes it cheap) before seeding.`);
    throw new Error(`${failed} clip(s) failed to generate`);
  }
  console.log(`\nNext: node scripts/seed-voice.mjs ${manifestPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
