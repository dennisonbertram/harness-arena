import { describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/storage")>()), getStorage: () => storageRef.current }));

import { GET } from "./route";

describe("GET /api/competitions", () => {
  it("returns the public competition projection and preserves null prizes", async () => {
    resetStorage();
    await storageRef.current.putCompetition({ id: "c1", arena: "harness-arena", harness: "pi", model: "zai/glm-5.2", gateway_provider: "morph", prize_amount_usd: null, prize_cadence: null, status: "live", created_at: "2026-07-28T00:00:00.000Z" });
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ id: "c1", arena: "harness-arena", harness: "pi", model: "zai/glm-5.2", gateway_provider: "morph", prize_amount_usd: null, prize_cadence: null, status: "live", created_at: "2026-07-28T00:00:00.000Z" }]);
  });
});
