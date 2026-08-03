import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/passive-monitor-cron.mjs", () => ({
  executePassiveMonitorCron: vi.fn().mockResolvedValue({ status: 200, body: { ok: true }, log_summary: { event: "passive_monitor.cron", observations: { development: "healthy", production: "access_blocked" }, actions: { planned: 1, applied: 1 } } }),
}));
vi.mock("@/lib/log", () => ({ log: vi.fn() }));

import { executePassiveMonitorCron } from "@/lib/passive-monitor-cron.mjs";
import { log } from "@/lib/log";
import { GET } from "./route";

describe("GET /api/cron/agent-monitor", () => {
  it("delegates once and emits only the returned sanitized summary", async () => {
    const request = new Request("https://development.example/api/cron/agent-monitor", { headers: { authorization: "Bearer secret" } });
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(executePassiveMonitorCron).toHaveBeenCalledWith(expect.objectContaining({ request, env: process.env, fetchImpl: globalThis.fetch }));
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("info", "passive_monitor.cron", expect.objectContaining({ observations: { development: "healthy", production: "access_blocked" }, actions: { planned: 1, applied: 1 } }));
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toMatch(/Bearer secret/);
  });
});
