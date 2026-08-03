import { beforeEach, describe, expect, it, vi } from "vitest";
import { mintVoiceCapability, verifyVoiceCapability } from "./voice-capability";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const NOW = Date.parse("2026-08-03T12:00:00.000Z");

describe("versioned voice capability", () => {
  beforeEach(() => vi.stubEnv("AUTH_SECRET", "test-auth-secret-with-at-least-thirty-two-bytes"));

  it("mints a versioned iat/exp capability and verifies within its bounded lifetime", () => {
    const token = mintVoiceCapability(ID, { now: NOW });
    expect(token.split(".")).toHaveLength(5);
    expect(token.startsWith("v1.")).toBe(true);
    expect(verifyVoiceCapability(token, { now: NOW + 60_000 })).toBe(ID);
  });

  it("rejects expired, far-future, overlong-window, legacy, and tampered capabilities", () => {
    const token = mintVoiceCapability(ID, { now: NOW });
    expect(verifyVoiceCapability(token, { now: NOW + 25 * 60 * 60 * 1000 })).toBeUndefined();
    expect(verifyVoiceCapability(token, { now: NOW - 10 * 60 * 1000 })).toBeUndefined();
    expect(verifyVoiceCapability(`${ID}.legacy-signature`, { now: NOW })).toBeUndefined();
    const [version, id, iat, , signature] = token.split(".");
    expect(verifyVoiceCapability(`${version}.${id}.${iat}.${Number(iat) + 8 * 24 * 60 * 60}.${signature}`, { now: NOW })).toBeUndefined();
    expect(verifyVoiceCapability(`${token.slice(0, -1)}x`, { now: NOW })).toBeUndefined();
  });
});
