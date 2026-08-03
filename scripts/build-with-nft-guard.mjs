import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVoiceAudioNft } from "./check-voice-audio-nft.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nftPath = resolve(root, ".next/server/app/api/voice/audio/[kind]/[id]/route.js.nft.json");
await rm(nftPath, { force: true });

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const result = spawnSync(process.execPath, [nextBin, "build"], { cwd: root, env: process.env, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await checkVoiceAudioNft({ nftPath });
