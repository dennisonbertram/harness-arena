import { describe, expect, it } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVoiceAudioNft, inspectVoiceAudioNft } from "./check-voice-audio-nft.mjs";

describe("voice audio NFT artifact guard", () => {
  it("rejects test, script, config, and repo-wide project files", () => {
    const root = "/repo";
    const nftPath = "/repo/.next/server/app/api/voice/audio/route.js.nft.json";
    const result = inspectVoiceAudioNft([
      "../../../../../../lib/voice-storage.mjs",
      "../../../../../../lib/voice-storage.test.ts",
      "../../../../../../scripts/seed-voice.mjs",
      "../../../../../../config/development-environment.json",
      "../../../../../../next.config.ts",
    ], { root, nftPath });
    expect(result.forbidden).toEqual(expect.arrayContaining([
      "lib/voice-storage.test.ts",
      "scripts/seed-voice.mjs",
      "config/development-environment.json",
      "next.config.ts",
    ]));
  });

  it("rejects env files and application source outside the explicit deployment allowlist", () => {
    const root = "/repo";
    const nftPath = "/repo/.next/server/app/api/voice/audio/route.js.nft.json";
    const result = inspectVoiceAudioNft([
      "../../../../../../.env.production",
      "../../../../../../lib/voice-storage.ts",
    ], { root, nftPath });
    expect(result.forbidden).toEqual([".env.production", "lib/voice-storage.ts"]);
  });

  it("accepts a recreated NFT when filesystem timestamp granularity rounds before build start", async () => {
    const root = await mkdtemp(join(tmpdir(), "voice-nft-coarse-time-"));
    const nftPath = join(root, "route.js.nft.json");
    const buildStartedAtMs = Date.now();
    try {
      await writeFile(nftPath, JSON.stringify({ files: [] }));
      const coarseTimestamp = new Date(buildStartedAtMs - 999);
      await utimes(nftPath, coarseTimestamp, coarseTimestamp);
      await expect(checkVoiceAudioNft({ nftPath, buildStartedAtMs })).resolves.toEqual({ projectFiles: [], forbidden: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the current build artifact is missing", async () => {
    await expect(checkVoiceAudioNft({ nftPath: "/does/not/exist" })).rejects.toThrow(/missing|ENOENT/i);
  });
});
