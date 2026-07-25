import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("competition-config", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults COMPETITION_MODEL to zai/glm-5.2 when the env var is unset", async () => {
    delete process.env.COMPETITION_MODEL;
    const { COMPETITION_MODEL } = await import("./competition-config");
    expect(COMPETITION_MODEL).toBe("zai/glm-5.2");
  });

  it("honors a valid COMPETITION_MODEL override from the allowlist", async () => {
    vi.stubEnv("COMPETITION_MODEL", "anthropic/claude-sonnet-5");
    const { COMPETITION_MODEL } = await import("./competition-config");
    expect(COMPETITION_MODEL).toBe("anthropic/claude-sonnet-5");
  });

  it("throws at import time when COMPETITION_MODEL is not in ALLOWED_MODELS (fail fast, not at request time)", async () => {
    vi.stubEnv("COMPETITION_MODEL", "not-a-real-model");
    await expect(import("./competition-config")).rejects.toThrow(/not in ALLOWED_MODELS/);
  });

  it("competitionAdminToken() reads the current env var, undefined when unset", async () => {
    delete process.env.COMPETITION_ADMIN_TOKEN;
    const { competitionAdminToken } = await import("./competition-config");
    expect(competitionAdminToken()).toBeUndefined();

    vi.stubEnv("COMPETITION_ADMIN_TOKEN", "secret-value");
    expect(competitionAdminToken()).toBe("secret-value");
  });
});
