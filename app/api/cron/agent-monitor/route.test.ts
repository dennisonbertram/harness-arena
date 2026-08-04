import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => vi.unstubAllEnvs());

  it("emits one sanitized trace-correlated monitor.observation per fixed environment", async () => {
    vi.stubEnv("CRON_SECRET", "route-cron-secret");
    vi.stubEnv("DEVELOPMENT_OPS_READ_TOKEN", "route-development-read-token");
    vi.stubEnv("PRODUCTION_OPS_READ_TOKEN", "route-production-read-token");
    vi.stubEnv("VERCEL_READ_TOKEN", "route-vercel-read-token");
    vi.stubEnv("VERCEL_PROJECT_ID", "route-development-project");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_URL", "harness-arena-development-git-dev-unique.vercel.app");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_development_1");
    const request = new Request("https://harness-arena-development.vercel.app/api/cron/agent-monitor", { headers: { authorization: "Bearer route-secret" } });
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(executePassiveMonitorCron).toHaveBeenCalledWith({
      request,
      env: {
        CRON_SECRET: "route-cron-secret",
        DEVELOPMENT_OPS_READ_TOKEN: "route-development-read-token",
        PRODUCTION_OPS_READ_TOKEN: "route-production-read-token",
        VERCEL_READ_TOKEN: "route-vercel-read-token",
        VERCEL_PROJECT_ID: "route-development-project",
        VERCEL_ENV: "production",
        VERCEL_URL: "harness-arena-development-git-dev-unique.vercel.app",
        VERCEL_DEPLOYMENT_ID: "dpl_development_1",
      },
      fetchImpl: globalThis.fetch,
    });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenNthCalledWith(1, "info", "monitor.observation", expect.objectContaining({
      target_environment: "development",
      target_deployment_sha: "abc",
      verdict: "healthy",
    }));
    expect(log).toHaveBeenNthCalledWith(2, "warn", "monitor.observation", expect.objectContaining({
      target_environment: "production",
      target_deployment_sha: null,
      verdict: "access_blocked",
    }));
    for (const [, , fields] of vi.mocked(log).mock.calls) {
      expect(fields).not.toHaveProperty("environment");
      expect(fields).not.toHaveProperty("deployment_sha");
    }
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toMatch(/route-secret|authorization/i);
  });

  it("returns non-success when the sole retained evidence cannot be emitted", async () => {
    vi.mocked(log).mockReturnValueOnce(true).mockReturnValueOnce(false);
    const response = await GET(new Request("https://harness-arena-development.vercel.app/api/cron/agent-monitor", { headers: { authorization: "Bearer route-secret" } }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "observation_not_retained" });
  });

  it("does not emit a log for an unauthenticated request", async () => {
    vi.mocked(executePassiveMonitorCron).mockResolvedValueOnce({ status: 401, body: { ok: false, error: "unauthorized" }, events: [] });
    vi.mocked(log).mockClear();
    const response = await GET(new Request("https://harness-arena-development.vercel.app/api/cron/agent-monitor"));
    expect(response.status).toBe(401);
    expect(log).not.toHaveBeenCalled();
  });
});
