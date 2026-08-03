import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/passive-monitor-cron.mjs", () => ({
  executePassiveMonitorCron: vi.fn().mockResolvedValue({
    status: 200,
    body: { ok: true, observations: [{ environment: "development", verdict: "healthy" }, { environment: "production", verdict: "access_blocked" }] },
    events: [
      { event: "monitor.observation", timestamp: "2026-08-03T12:00:00.000Z", environment: "development", verdict: "healthy", kind: "healthy", deployment_sha: "abc", failing_checks: [], correlation_ids: [] },
      { event: "monitor.observation", timestamp: "2026-08-03T12:00:00.000Z", environment: "production", verdict: "access_blocked", kind: "access_blocked", deployment_sha: null, failing_checks: [{ code: "ops_access_missing", severity: "access" }], correlation_ids: [] },
    ],
  }),
}));
vi.mock("@/lib/log", () => ({ log: vi.fn().mockReturnValue(true) }));

import { executePassiveMonitorCron } from "@/lib/passive-monitor-cron.mjs";
import { log } from "@/lib/log";
import { GET } from "./route";

describe("GET /api/cron/agent-monitor", () => {
  it("emits one sanitized trace-correlated monitor.observation per fixed environment", async () => {
    const request = new Request("https://harness-arena-development.vercel.app/api/cron/agent-monitor", { headers: { authorization: "Bearer route-secret" } });
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(executePassiveMonitorCron).toHaveBeenCalledWith(expect.objectContaining({ request, env: process.env, fetchImpl: globalThis.fetch }));
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenNthCalledWith(1, "info", "monitor.observation", expect.objectContaining({ environment: "development", verdict: "healthy" }));
    expect(log).toHaveBeenNthCalledWith(2, "warn", "monitor.observation", expect.objectContaining({ environment: "production", verdict: "access_blocked" }));
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toMatch(/route-secret|authorization/i);
  });

  it("returns non-success when the sole retained evidence cannot be emitted", async () => {
    vi.mocked(log).mockReturnValueOnce(true).mockReturnValueOnce(false);
    const response = await GET(new Request("https://harness-arena-development.vercel.app/api/cron/agent-monitor", { headers: { authorization: "Bearer route-secret" } }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "observation_not_retained" });
  });
});
