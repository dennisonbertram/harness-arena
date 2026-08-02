import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  listSubmissions: vi.fn(), listRuns: vi.fn(), listCompetitions: vi.fn(),
  getSubmission: vi.fn(), getRun: vi.fn(), getCompetition: vi.fn(),
  listRunEvents: vi.fn(), getTraceBytes: vi.fn(),
  putSubmission: vi.fn(), putRun: vi.fn(), putCompetition: vi.fn(), appendRunEvents: vi.fn(), putTraceBlob: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({ getStorage: () => storage }));
vi.mock("@/lib/reaper", () => ({ reapIfStale: vi.fn() }));
vi.mock("@/lib/dispatch", () => ({ dispatchQueuedRuns: vi.fn() }));

import { GET } from "./route";

const request = (path = "/api/ops/v1", method = "GET", token = "read-token") =>
  new NextRequest(`http://localhost${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("ops read API", () => {
  beforeEach(() => {
    process.env.OPS_READ_TOKEN = "read-token";
    vi.clearAllMocks();
    storage.listSubmissions.mockResolvedValue([{ id: "s1", created_at: "2026-01-01T00:00:00.000Z" }]);
    storage.listRuns.mockResolvedValue([{ id: "r1", status: "queued", created_at: "2026-01-01T00:00:00.000Z" }]);
    storage.listCompetitions.mockResolvedValue([]);
  });

  it("fails closed, is GET-only, is no-store, and cannot reach write/reaper/dispatch paths", async () => {
    expect((await GET(request("/api/ops/v1", "GET", ""))).status).toBe(401);
    expect((await GET(request("/api/ops/v1", "GET", "wrong"))).status).toBe(401);
    expect((await GET(request("/api/ops/v1", "POST"))).status).toBe(405);
    const response = await GET(request());
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ schema_version: "ops.v1", kinds: expect.any(Array) });
    expect(storage.putSubmission).not.toHaveBeenCalled();
    expect(storage.appendRunEvents).not.toHaveBeenCalled();
  });
});
