import { beforeEach, describe, expect, it, vi } from "vitest";

const { readiness, listRuns, listSubmissions, getManifest, getVoiceStorage } = vi.hoisted(() => ({
  readiness: vi.fn(), listRuns: vi.fn(), listSubmissions: vi.fn(), getManifest: vi.fn(),
  getVoiceStorage: vi.fn(() => ({ getManifest: vi.fn() })),
}));
vi.mock("@/lib/storage", () => ({ getStorage: () => ({ listRuns, listSubmissions, checkReady: readiness }) }));
vi.mock("@/lib/voice-storage", () => ({ getVoiceStorage: () => { getVoiceStorage(); return { getManifest }; } }));
import { GET } from "./route";

describe("GET /api/ready", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    readiness.mockReset().mockResolvedValue({ seeded: true, writable: true });
    listRuns.mockReset().mockResolvedValue([]);
    listSubmissions.mockReset().mockResolvedValue([]);
    getManifest.mockReset().mockResolvedValue(undefined);
    vi.stubEnv("LOCAL_INSTANCE_NONCE", "nonce-1");
    vi.stubEnv("LOCAL_INSTANCE_PID", String(process.pid));
    getVoiceStorage.mockClear();
  });
  it("binds readiness to the current process instance and verifies seed/writeability", async () => {
    vi.stubEnv("HARNESS_LOCAL_INIT", "1");
    vi.stubEnv("STORAGE", "file");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, pid: process.pid, nonce: "nonce-1", seeded: true, writable: true });
    expect(readiness).toHaveBeenCalledOnce();
  });
  it("returns 503 when local seed or writeability validation fails", async () => {
    vi.stubEnv("HARNESS_LOCAL_INIT", "1");
    vi.stubEnv("STORAGE", "file");
    readiness.mockRejectedValue(new Error("not writable"));
    expect((await GET()).status).toBe(503);
  });
  it("keeps hosted readiness bounded and never enumerates production storage", async () => {
    vi.stubEnv("STORAGE", "blob");
    vi.stubEnv("AUTH_SECRET", "auth-secret");
    vi.stubEnv("OPS_READ_TOKEN", "ops-secret");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, storage: "ready" });
    expect(readiness).not.toHaveBeenCalled();
    expect(listRuns).not.toHaveBeenCalled();
    expect(listSubmissions).not.toHaveBeenCalled();
    expect(getManifest).not.toHaveBeenCalled();
    expect(getVoiceStorage).toHaveBeenCalledOnce();
  });

  it.each(["AUTH_SECRET", "OPS_READ_TOKEN"])("returns 503 when hosted %s capability is missing", async (key) => {
    vi.stubEnv("STORAGE", "blob");
    vi.stubEnv("AUTH_SECRET", "auth-secret");
    vi.stubEnv("OPS_READ_TOKEN", "ops-secret");
    vi.stubEnv(key, "");
    expect((await GET()).status).toBe(503);
  });

  it("returns 503 when hosted credentials overlap and never exposes their values", async () => {
    vi.stubEnv("STORAGE", "blob");
    vi.stubEnv("AUTH_SECRET", "shared-secret");
    vi.stubEnv("OPS_READ_TOKEN", "shared-secret");
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("shared-secret");
  });
  it("refuses a local-init marker unless the file-backed local storage mode is selected", async () => {
    vi.stubEnv("HARNESS_LOCAL_INIT", "1");
    vi.stubEnv("STORAGE", "memory");
    expect((await GET()).status).toBe(503);
    expect(readiness).not.toHaveBeenCalled();
  });
});
