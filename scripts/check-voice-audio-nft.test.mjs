import { describe, expect, it } from "vitest";
import { inspectVoiceAudioNft } from "./check-voice-audio-nft.mjs";

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
});
