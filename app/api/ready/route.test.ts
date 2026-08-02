import { beforeEach, describe, expect, it, vi } from "vitest";

const readiness = vi.fn();
vi.mock("@/lib/storage", () => ({ getStorage: () => ({ listRuns: vi.fn(), listSubmissions: vi.fn(), checkReady: readiness }) }));
vi.mock("@/lib/voice-storage", () => ({ getVoiceStorage: () => ({ getManifest: vi.fn() }) }));
import { GET } from "./route";

describe("GET /api/ready", () => {
  beforeEach(() => { readiness.mockReset().mockResolvedValue({ seeded: true, writable: true }); process.env.LOCAL_INSTANCE_NONCE = "nonce-1"; process.env.LOCAL_INSTANCE_PID = String(process.pid); });
  it("binds readiness to the current process instance and verifies seed/writeability", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, pid: process.pid, nonce: "nonce-1", seeded: true, writable: true });
    expect(readiness).toHaveBeenCalledOnce();
  });
  it("returns 503 when local seed or writeability validation fails", async () => {
    readiness.mockRejectedValue(new Error("not writable"));
    expect((await GET()).status).toBe(503);
  });
});
