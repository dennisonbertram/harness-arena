import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  listPage: vi.fn().mockResolvedValue({
    records: Array.from({ length: 101 }, (_, index) => ({ pathname: `runs/r${index}.json`, size: 1, uploaded_at: "2026-08-03T00:00:00.000Z", etag: String(index) })),
    has_more: false,
  }),
  read: vi.fn(),
}));
vi.mock("@/lib/ops-read-adapter", () => ({ getOpsReadAdapter: () => storage }));

import { GET } from "./route";

describe("GET ops inventory", () => {
  it("maps an adapter page contract violation to a server failure", async () => {
    process.env.OPS_READ_TOKEN = "read-token";
    process.env.OPS_READ_CURSOR_SECRET = "cursor-secret";
    const response = await GET(new NextRequest("http://localhost/api/ops/v1/inventory?kind=runs&limit=100", { headers: { authorization: "Bearer read-token" } }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "page_item_limit", limit: 100, received: 101 }, partial: true });
  });
});
