import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const voice = vi.hoisted(() => ({ getVoiceStorage: vi.fn() }));
vi.mock("@/lib/voice-storage", () => voice);
import { GET } from "./route";

const params = (kind: string, id: string) => Promise.resolve({ kind, id });
const req = (cookie?: string) => new NextRequest("https://x.test/api/voice/audio/prompts/prompt-1", { headers: cookie ? { cookie } : undefined });

describe("GET voice audio", () => {
  it("rejects anonymous delivery before opening a blob", async () => {
    const getAudioBytes = vi.fn();
    voice.getVoiceStorage.mockReturnValue({ getAudioBytes });
    const response = await GET(req(), { params: params("prompts", "prompt-1") });
    expect(response.status).toBe(401);
    expect(getAudioBytes).not.toHaveBeenCalled();
  });
});
