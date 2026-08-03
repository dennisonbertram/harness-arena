import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => vi.fn());
const storage = vi.hoisted(() => ({
  listSubmissions: vi.fn().mockResolvedValue([]), listRuns: vi.fn().mockResolvedValue([]), listCompetitions: vi.fn().mockResolvedValue([]),
  listRunEvents: vi.fn(), getTraceBytes: vi.fn(),
}));
vi.mock("@/lib/log", () => ({ log }));
vi.mock("@/lib/storage", () => ({ getStorage: () => storage }));
vi.mock("@/lib/reaper", () => ({ reapIfStale: vi.fn() }));
vi.mock("@/lib/dispatch", () => ({ dispatchQueuedRuns: vi.fn() }));

import { GET as baseGet, POST as basePost } from "./route";
import { GET as inventoryGet } from "./inventory/route";
import { GET as readGet } from "./read/route";
import { GET as summaryGet } from "./summary/route";

const request = (pathname: string, token = "read-token") => new NextRequest(`http://localhost${pathname}`, { headers: { authorization: `Bearer ${token}` } });

describe("ops v1 route observability", () => {
  beforeEach(() => { process.env.OPS_READ_TOKEN = "read-token"; process.env.OPS_READ_CURSOR_SECRET = "cursor-secret"; log.mockClear(); });

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
});
