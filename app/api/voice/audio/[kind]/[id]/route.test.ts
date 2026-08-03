import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installVoiceCapabilityTestSecret } from "@/lib/test-support/voice-capability";
import { voiceCapabilityCookie } from "@/lib/test-support/voice-capability";

const voice = vi.hoisted(() => ({ getVoiceStorage: vi.fn() }));
vi.mock("@/lib/voice-storage", () => voice);
import { GET } from "./route";

const params = (kind: string, id: string) => Promise.resolve({ kind, id });
const req = (cookie?: string) => new NextRequest("https://x.test/api/voice/audio/prompts/prompt-1", { headers: cookie ? { cookie } : undefined });

describe("GET voice audio", () => {
  beforeEach(() => installVoiceCapabilityTestSecret());
  it("rejects anonymous delivery before opening a blob", async () => {
    const getAudioBytes = vi.fn();
    voice.getVoiceStorage.mockReturnValue({ getAudioBytes });
    const response = await GET(req(), { params: params("prompts", "prompt-1") });
    expect(response.status).toBe(401);
    expect(getAudioBytes).not.toHaveBeenCalled();
  });

  it("rejects a forged UUID cookie and an object outside the active manifest", async () => {
    const getAudioBytes = vi.fn();
    voice.getVoiceStorage.mockReturnValue({ getAudioBytes, getManifest: vi.fn().mockResolvedValue({ prompts: [], responses: [] }) });
    const forged = await GET(req("voice_evaluator=4f51bb74-25e4-4a96-a9ca-5f46ca3dbe61"), { params: params("prompts", "prompt-1") });
    expect(forged.status).toBe(401);
    expect(getAudioBytes).not.toHaveBeenCalled();
  });

  it("rejects a signed capability requesting an object outside the active manifest", async () => {
    const getAudioBytes = vi.fn();
    voice.getVoiceStorage.mockReturnValue({ getAudioBytes, getManifest: vi.fn().mockResolvedValue({ prompts: [], responses: [] }) });
    const cookie = `voice_evaluator=${voiceCapabilityCookie("4f51bb74-25e4-4a96-a9ca-5f46ca3dbe61")}`;
    const response = await GET(req(cookie), { params: params("prompts", "prompt-1") });
    expect(response.status).toBe(404);
    expect(getAudioBytes).not.toHaveBeenCalled();
  });

  it("streams an active-manifest clip without exposing its Blob URL", async () => {
    voice.getVoiceStorage.mockReturnValue({
      getManifest: vi.fn().mockResolvedValue({ prompts: [{ id: "prompt-1" }], responses: [] }),
      getAudioBytes: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
    });
    const cookie = `voice_evaluator=${voiceCapabilityCookie("4f51bb74-25e4-4a96-a9ca-5f46ca3dbe61")}`;
    const response = await GET(req(cookie), { params: params("prompts", "prompt-1") });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
