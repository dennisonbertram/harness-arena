import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintVoiceCapability } from "@/lib/voice-capability";
import { installVoiceCapabilityTestSecret } from "@/lib/test-support/voice-capability";

const { getVoiceStorage } = vi.hoisted(() => ({ getVoiceStorage: vi.fn() }));
vi.mock("@/lib/voice-storage", () => ({ getVoiceStorage }));

import { POST } from "./route";

describe("POST /api/voice/capability", () => {
  beforeEach(() => installVoiceCapabilityTestSecret());
  afterEach(() => vi.restoreAllMocks());

  it.each(["direct", "expired"])("mints a dedicated capability for a %s visitor without evaluation state access", async (kind) => {
    const headers = new Headers();
    if (kind === "expired") {
      headers.set("cookie", `voice_evaluator=${mintVoiceCapability("11111111-1111-4111-8111-111111111111", { now: Date.now() - 48 * 60 * 60 * 1000 })}`);
    }
    const response = await POST(new NextRequest("http://localhost/api/voice/capability", { method: "POST", headers }));
    expect(response.status).toBe(204);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^voice_evaluator=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).toMatch(/Max-Age=86400/i);
    expect(getVoiceStorage).not.toHaveBeenCalled();
  });
});
