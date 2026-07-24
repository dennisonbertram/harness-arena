# Voice Arena dataset generation

Two commands take a prompt list to a live arena:

```bash
node --env-file=.env scripts/generate-voice-clips.mjs scripts/voice-prompts-starter.json --out voice-dataset
node --env-file=.env.local scripts/seed-voice.mjs voice-dataset/manifest.json
```

Run both from the repo root — the manifest's file paths resolve from the CWD you generate in.

## Prompts file

```json
{ "prompts": [ { "key": "tallest-mountain", "text": "Hey, quick one — what's the tallest mountain in the world?", "category": "factual" } ] }
```

Keys are stable researcher-chosen slugs; they drive filenames, caching, and (via seed-voice) judgment-preserving ID reuse. The starter set (`scripts/voice-prompts-starter.json`) covers the PRD's categories: factual, short-explanation, emotional, high-energy, sensitive, pronunciation (names / numbers / acronyms), ambiguous, clarification, concise-instruction, storytelling.

## What the generator does

- **Responses**: each configured model (default `openai/gpt-audio` and `openai/gpt-audio-mini`, via OpenRouter) answers the prompt itself and speaks it — one streamed call per clip (`stream: true` + `pcm16` is an OpenRouter requirement for audio output; the script wraps the PCM in a WAV header at 24 kHz mono). Both models are pinned to the same voice (`--voice`, default `alloy`) to control the voice-identity confound. The response payload does not echo the voice used — spot-check by ear when changing models/voices.
- **Prompts**: the AI Gateway has no speech endpoint today (`/v1/audio/speech` → 404, verified 2026-07-24), so prompt audio comes from the say-exactly fallback (second configured model reads the prompt text verbatim in `--prompt-voice`, default `nova`). The gateway `tts-1` attempt stays in the code and will be preferred automatically if the endpoint appears.
- **Transcripts**: every response's answer text is stored as a sidecar (`responses/<key>__<model>.txt`), flows into the manifest, and seed-voice carries it into the remote `voice/manifest.json` for research use (the app ignores it).
- **Caching/resume**: existing valid WAVs (size + RIFF check) are skipped; interrupted writes can't poison the cache (temp+rename). `--force` regenerates. `--limit N` bounds a run. A failed clip never aborts the batch; prompts without full model coverage are excluded from the manifest, and the seed command is only printed on a fully clean run.

## Durability rule (important)

**Keep `voice-dataset/` — it is committed to the repo on purpose.** Generation is nondeterministic: a cold-cache re-run produces new audio bytes for every clip, seed-voice's content-hash check then re-mints every ID, and ALL collected judgments become orphans (not just fixtures). The committed dataset directory is simultaneously the research artifact and the only protection against that. Adding prompts is safe: new keys generate, existing keys stay cached and keep their IDs.

## Environment keys

- `OPENROUTER_API_KEY` (responses + fallback prompt TTS) — from `.env`. Gotcha: `node --env-file` does NOT override a key already exported by your shell profile; if a stale `OPENROUTER_API_KEY` lives in your profile, export the `.env` value explicitly before running.
- `AI_GATEWAY_API_KEY` — only needed for the (currently 404) gateway TTS path.
- `BLOB_READ_WRITE_TOKEN` (seeding) — from `.env.local`.

## Cost and scale

The 12-prompt starter run (36 clips, ~8–9s average responses) costs on the order of cents to low dollars on OpenRouter. `--limit 1` first when experimenting.

## Re-seed semantics

Seeding fully replaces `voice/manifest.json`. Judgments referencing response IDs no longer in the manifest are excluded from results and surfaced as an orphan count — expected when replacing fixtures or changing audio under an existing key.
