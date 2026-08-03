import { describe, expect, it } from "vitest";
import { OPS_RECORD_KINDS, createOpsReadService } from "./ops-read";

describe("ops read inventory contract", () => {
  it("derives every known persisted prefix from the read-only inventory", async () => {
    expect(OPS_RECORD_KINDS.map((kind) => kind.prefix)).toEqual([
      "submissions/", "runs/", "competitions/", "events/", "traces/", "voice/manifest.json", "voice/judgments/",
      "voice/audio/prompts/", "voice/audio/responses/", "archives/competition-cleanup-operations/",
      "archives/competition-cleanups/", "archives/competition-resets/", "archives/",
    ]);
    const service = createOpsReadService();
    await expect(service.list("traces", { limit: 101 })).resolves.toMatchObject({ error: { code: "invalid_limit" } });
  });
});
