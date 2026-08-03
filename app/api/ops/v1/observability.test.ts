import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => vi.fn());
const opsService = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), summary: vi.fn() }));
const storage = vi.hoisted(() => ({
  listSubmissions: vi.fn().mockResolvedValue([]), listRuns: vi.fn().mockResolvedValue([]), listCompetitions: vi.fn().mockResolvedValue([]),
  listRunEvents: vi.fn(), getTraceBytes: vi.fn(),
}));
vi.mock("@/lib/log", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/log")>(), log }));
vi.mock("@/lib/storage", () => ({ getStorage: () => storage }));
vi.mock("@/lib/reaper", () => ({ reapIfStale: vi.fn() }));
vi.mock("@/lib/dispatch", () => ({ dispatchQueuedRuns: vi.fn() }));
vi.mock("@/lib/ops-read", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/ops-read")>(),
  createOpsReadService: () => opsService,
}));

import { GET as baseGet, POST as basePost } from "./route";
import { GET as inventoryGet } from "./inventory/route";
import { GET as readGet } from "./read/route";
import { GET as summaryGet } from "./summary/route";

const request = (pathname: string, token = "read-token") => new NextRequest(`http://localhost${pathname}`, { headers: { authorization: `Bearer ${token}` } });

describe("ops v1 route observability", () => {
  beforeEach(() => {
    process.env.OPS_READ_TOKEN = "read-token";
    process.env.OPS_READ_CURSOR_SECRET = "cursor-secret";
    log.mockClear();
    opsService.list.mockReset().mockResolvedValue({ items: [], has_more: false, next_cursor: null });
    opsService.read.mockReset().mockResolvedValue({ item: {}, metadata: {} });
    opsService.summary.mockReset().mockResolvedValue({ counts: {}, latest: {}, integrity: {} });
  });

  it("emits correlated structured success for each GET route", async () => {
    await baseGet(request("/api/ops/v1"));
    await inventoryGet(request("/api/ops/v1/inventory?kind=runs"));
    await readGet(request("/api/ops/v1/read?kind=unknown"));
    await summaryGet(request("/api/ops/v1/summary"));
    expect(log).toHaveBeenCalledTimes(4);
    expect(log.mock.calls.map(([, event]) => event)).toEqual(["ops.request.succeeded", "ops.request.succeeded", "ops.request.controlled_failure", "ops.request.succeeded"]);
    for (const [, , fields] of log.mock.calls) expect(fields).toMatchObject({ method: "GET", route: expect.stringMatching(/^\/api\/ops\/v1/) });
  });

  it("emits a controlled-failure event while retaining the explicit GET-only 405", async () => {
    const response = await basePost(new NextRequest("http://localhost/api/ops/v1", { method: "POST", headers: { authorization: "Bearer read-token" } }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(log).toHaveBeenCalledWith("warn", "ops.request.controlled_failure", expect.objectContaining({ method: "POST", status: 405 }));
  });

  it("classifies expected 503 responses as controlled failures", async () => {
    opsService.list.mockResolvedValueOnce({ error: { code: "partial_read" }, partial: true });
    const response = await inventoryGet(request("/api/ops/v1/inventory?kind=runs"));
    expect(response.status).toBe(503);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("warn", "ops.request.controlled_failure", expect.objectContaining({ status: 503 }));
  });

  it("emits exactly one unexpected-failure event and rethrows for every GET route", async () => {
    const cases: Array<[string, () => Promise<Response>, () => void]> = [
      ["/api/ops/v1", () => {
        const source = request("/api/ops/v1");
        const hostile = new Proxy(source, { get(target, property) {
          if (property === "headers") throw new Error("base request failed");
          return Reflect.get(target, property, target);
        } });
        return baseGet(hostile);
      }, () => {}],
      ["/api/ops/v1/inventory", () => inventoryGet(request("/api/ops/v1/inventory?kind=runs")), () => {
        opsService.list.mockRejectedValueOnce(new Error("inventory failed"));
      }],
      ["/api/ops/v1/read", () => readGet(request("/api/ops/v1/read?kind=runs&id=r1")), () => {
        opsService.read.mockRejectedValueOnce(new Error("read failed"));
      }],
      ["/api/ops/v1/summary", () => summaryGet(request("/api/ops/v1/summary")), () => {
        opsService.summary.mockRejectedValueOnce(new Error("summary failed"));
      }],
    ];
    for (const [route, invoke, arrange] of cases) {
      log.mockClear();
      arrange();
      await expect(invoke()).rejects.toBeInstanceOf(Error);
      expect(log, route).toHaveBeenCalledOnce();
      expect(log, route).toHaveBeenCalledWith("error", "ops.request.unexpected_failure", expect.objectContaining({ route, method: "GET", status: 500 }));
      vi.restoreAllMocks();
    }
  });
});
