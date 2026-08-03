import { describe, expect, it, vi } from "vitest";
import { createOpsReadService } from "./ops-read";
import type { OpsReadAdapter } from "./ops-read-adapter";

describe("ops summary integrity", () => {
  it("reports event holes and bounded scan completeness using numeric aggregates only", async () => {
    const adapter: OpsReadAdapter = {
      listPage: vi.fn(async ({ prefix }) => ({
        records: prefix === "events/" ? [
          { pathname: "events/run-1/0000000001.json", size: 10, uploaded_at: "2026-08-02T00:00:01.000Z", etag: "1" },
          { pathname: "events/run-1/0000000003.json", size: 10, uploaded_at: "2026-08-02T00:00:03.000Z", etag: "3" },
        ] : [], has_more: false,
      })),
      read: vi.fn(async ({ pathname }) => ({ status: "ok" as const, bytes: Buffer.from(JSON.stringify({ type: "event" })), metadata: { pathname, size: 1, uploaded_at: "2026-08-02T00:00:00.000Z", etag: "e" } })),
    };
    const summary = await createOpsReadService(adapter).summary();
    expect(summary.integrity.event_holes).toBe(1);
    expect(summary.counts.events).toBe(2);
    expect(summary.latest.events).toBe("2026-08-02T00:00:03.000Z");
    expect(summary.scan).toEqual({ records: 2, complete: true, truncated: false });
    expect(JSON.stringify(summary)).not.toContain("payload");
  });
});
