import { describe, expect, it, vi } from "vitest";
import { createOpsReadService } from "./ops-read";
import type { OpsReadAdapter } from "./ops-read-adapter";

describe("ops storage pagination", () => {
  it("preserves the Blob cursor and reports event holes in the bounded page", async () => {
    process.env.OPS_READ_TOKEN = "cursor-secret";
    process.env.OPS_READ_CURSOR_SECRET = "server-cursor-secret";
    const listPage = vi.fn().mockResolvedValue({
      records: [
        { pathname: "events/run-1/0000000001.json", size: 1, uploaded_at: "2026-08-02T00:00:01.000Z", etag: "1" },
        { pathname: "events/run-1/0000000003.json", size: 1, uploaded_at: "2026-08-02T00:00:03.000Z", etag: "3" },
      ], cursor: "blob-next", has_more: true,
    });
    const service = createOpsReadService({ listPage, read: vi.fn() } as OpsReadAdapter);
    const page = await service.list("events", { limit: 2, run_id: "run-1" });
    expect(page).toMatchObject({ has_more: true, integrity: { event_holes: 1, corrupt: 0 } });
    expect(page.next_cursor).toEqual(expect.any(String));
    await service.list("events", { limit: 2, run_id: "run-1", cursor: page.next_cursor! });
    expect(listPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "blob-next", limit: 2, prefix: "events/run-1/" }));
  });
});
