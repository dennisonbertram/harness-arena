import { describe, expect, it } from "vitest";
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

  it("rejects an NFT older than the current build start", async () => {
    await expect(checkVoiceAudioNft({ buildStartedAtMs: Date.now() + 60_000 })).rejects.toThrow(/stale|current build/i);
  });

  it("fails closed when the current build artifact is missing", async () => {
    await expect(checkVoiceAudioNft({ nftPath: "/does/not/exist" })).rejects.toThrow(/missing|ENOENT/i);
  });
});
