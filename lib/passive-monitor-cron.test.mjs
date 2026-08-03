import { describe, expect, it, vi } from "vitest";
import {
  DEVELOPMENT_PROJECT_ID,
  createGitHubIncidentAdapter,
  executePassiveMonitorCron,
} from "./passive-monitor-cron.mjs";

const SHA = "a".repeat(40);
const runtimeEnv = (overrides = {}) => ({
  VERCEL_PROJECT_ID: DEVELOPMENT_PROJECT_ID,
  VERCEL_ENV: "production",
  VERCEL_URL: "harness-arena-development-a1b2c3.vercel.app",
  VERCEL_DEPLOYMENT_ID: "dpl_development_1",
  VERCEL_GIT_COMMIT_REF: "dev",
  VERCEL_GIT_COMMIT_SHA: SHA,
  CRON_SECRET: "development-cron-secret",
  DEVELOPMENT_OPS_READ_TOKEN: "dev-ops-secret",
  PRODUCTION_OPS_READ_TOKEN: "prod-ops-secret",
  GITHUB_MONITOR_ISSUES_TOKEN: "github-issues-secret",
  ...overrides,
});
const request = (secret = "development-cron-secret") => new Request("https://harness-arena-development-a1b2c3.vercel.app/api/cron/agent-monitor", { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const issue = (number) => ({ number, state: number % 2 ? "open" : "closed", title: `[agent-monitor] development: storage/${number}`, body: `<!-- harness-arena-monitor:{"fingerprint":"fp-${number}"} -->` });
const status = (environment, verdict = "healthy") => ({
  schema_version: "agent_ops_status.v1",
  checked_at: "2026-08-03T12:00:00.000Z",
  environment,
  verdict,
  exit_code: { healthy: 0, degraded: 1, failed: 2, access_blocked: 3 }[verdict],
  health: { sha: environment === "development" ? SHA : null },
  platform: { deployment: environment === "development" ? { id: "dpl_development_1", sha: SHA } : null },
  findings: verdict === "degraded" ? [{ code: "platform_evidence_unknown", severity: "degraded", detail: "unavailable" }] : [],
  blockers: verdict === "access_blocked" ? [{ code: "ops_access", severity: "access", detail: "HTTP 401" }] : [],
});

describe("bounded GitHub monitor incident REST adapter", () => {
  it("proves the provisioned label and fully paginates all labeled monitor issues", async () => {
    const first = Array.from({ length: 100 }, (_, index) => issue(index + 1));
    const fetchImpl = vi.fn(async (rawUrl, init) => {
      const url = new URL(rawUrl);
      expect(init).toMatchObject({ method: "GET", redirect: "manual", headers: expect.objectContaining({ authorization: "Bearer github-issues-secret", "x-github-api-version": "2022-11-28" }) });
      if (url.pathname.endsWith("/labels/agent-monitor")) return jsonResponse({ name: "agent-monitor" });
      if (url.searchParams.get("page") === "1") return jsonResponse(first);
      return jsonResponse([issue(101)]);
    });
    const github = createGitHubIncidentAdapter({ token: "github-issues-secret", fetchImpl, maxPages: 10 });
    await expect(github.verifyLabel()).resolves.toEqual({ name: "agent-monitor" });
    await expect(github.discoverIncidents()).resolves.toMatchObject({ complete: true, incidents: expect.arrayContaining([{ number: 1, state: "OPEN" }, { number: 101, state: "OPEN" }]) });
    expect((await github.discoverIncidents()).incidents).toHaveLength(101);
  });

  it.each([
    ["command status", vi.fn().mockResolvedValue(jsonResponse({ message: "denied" }, 403)), "github_request_failed"],
    ["malformed JSON", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })), "github_response_invalid"],
    ["non-array page", vi.fn().mockResolvedValue(jsonResponse({ issues: [] })), "incident_discovery_invalid"],
  ])("fails closed on %s", async (_name, fetchImpl, error) => {
    const github = createGitHubIncidentAdapter({ token: "github-issues-secret", fetchImpl });
    await expect(github.discoverIncidents()).rejects.toThrow(error);
  });

  it("fails closed instead of returning a truncated inventory", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(Array.from({ length: 100 }, (_, index) => issue(index + 1))));
    const github = createGitHubIncidentAdapter({ token: "github-issues-secret", fetchImpl, maxPages: 2 });
    await expect(github.discoverIncidents()).rejects.toThrow("incident_discovery_truncated");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("applies fixed, capped issue transitions and labels every new incident", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (rawUrl, init) => {
      calls.push({ url: String(rawUrl), method: init.method, body: init.body && JSON.parse(init.body) });
      return init.method === "POST" && String(rawUrl).endsWith("/issues") ? jsonResponse({ number: 501 }, 201) : jsonResponse({ ok: true });
    });
    const github = createGitHubIncidentAdapter({ token: "github-issues-secret", fetchImpl, maxActions: 10 });
    const observation = { environment: "development", checked_at: "2026-08-03T12:00:00.000Z", deployment_sha: SHA, request_ids: [], failures: [] };
    const actions = [
      { action: "create", fingerprint: "fp-new", reason: "new_failure", failure: { alert_class: "storage", code: "storage_down", detail: "storage_down" } },
      { action: "comment", number: 10, fingerprint: "fp-comment", reason: "recovery_pending" },
      { action: "reopen", number: 11, fingerprint: "fp-reopen", reason: "flap", failure: { alert_class: "queue", code: "stale_runs", detail: "stale_runs" } },
      { action: "close", number: 12, fingerprint: "fp-close", reason: "recovery_proven" },
    ];
    await expect(github.applyActions([{ observation, actions }])).resolves.toMatchObject({ complete: true, applied: 4 });
    expect(calls[0]).toMatchObject({ method: "POST", body: { labels: ["agent-monitor"] } });
    expect(calls.map(({ method }) => method)).toEqual(["POST", "POST", "PATCH", "PATCH", "POST", "POST", "PATCH"]);
    expect(calls.every(({ url }) => url.startsWith("https://api.github.com/repos/dennisonbertram/harness-arena/issues"))).toBe(true);
    await expect(github.applyActions([{ observation, actions: Array.from({ length: 11 }, () => actions[0]) }])).rejects.toThrow("incident_action_limit");
  });

  it("stops at the first incomplete issue application", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ number: 1 }, 201)).mockResolvedValueOnce(jsonResponse({ message: "failed" }, 500));
    const github = createGitHubIncidentAdapter({ token: "github-issues-secret", fetchImpl });
    const observation = { environment: "development", checked_at: "2026-08-03T12:00:00.000Z", deployment_sha: SHA, request_ids: [], failures: [] };
    const create = (fingerprint) => ({ action: "create", fingerprint, reason: "new_failure", failure: { alert_class: "storage", code: "storage_down", detail: "storage_down" } });
    await expect(github.applyActions([{ observation, actions: [create("one"), create("two"), create("three")] }])).rejects.toThrow("github_request_failed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("Development-only Vercel Cron orchestration", () => {
  it.each([
    ["VERCEL_PROJECT_ID", "prj_live", 404],
    ["VERCEL_ENV", "preview", 404],
    ["VERCEL_GIT_COMMIT_REF", "main", 404],
    ["VERCEL_GIT_COMMIT_SHA", "dirty", 404],
    ["VERCEL_URL", "harness-arena-psi.vercel.app", 404],
    ["CRON_SECRET", "", 401],
    ["GITHUB_MONITOR_ISSUES_TOKEN", "", 503],
    ["DEVELOPMENT_OPS_READ_TOKEN", "", 503],
  ])("fails closed before probes or GitHub writes for invalid %s", async (name, value, expectedStatus) => {
    const collectStatus = vi.fn(), github = { verifyLabel: vi.fn(), discoverIncidents: vi.fn(), applyActions: vi.fn() };
    const result = await executePassiveMonitorCron({ request: request(), env: runtimeEnv({ [name]: value }), collectStatus, github });
    expect(result.status).toBe(expectedStatus);
    expect(collectStatus).not.toHaveBeenCalled();
    expect(github.verifyLabel).not.toHaveBeenCalled();
  });

  it("requires the exact cron bearer secret", async () => {
    const collectStatus = vi.fn(), github = { verifyLabel: vi.fn(), discoverIncidents: vi.fn(), applyActions: vi.fn() };
    for (const candidate of ["", "wrong", "Bearer development-cron-secret"]) {
      expect((await executePassiveMonitorCron({ request: request(candidate), env: runtimeEnv(), collectStatus, github })).status).toBe(401);
    }
    expect(collectStatus).not.toHaveBeenCalled();
  });

  it("collects Development and production with separate tokens and immutable runtime identity", async () => {
    const collectStatus = vi.fn(async ({ environment }) => environment === "development" ? status("development") : status("production", "access_blocked"));
    const github = {
      verifyLabel: vi.fn().mockResolvedValue({ name: "agent-monitor" }),
      discoverIncidents: vi.fn().mockResolvedValue({ complete: true, incidents: [] }),
      applyActions: vi.fn().mockResolvedValue({ complete: true, applied: 1 }),
    };
    const result = await executePassiveMonitorCron({ request: request(), env: runtimeEnv({ PRODUCTION_OPS_READ_TOKEN: "" }), collectStatus, github, now: "2026-08-03T12:00:00.000Z" });
    expect(result).toMatchObject({ status: 200, body: { ok: true, observations: { development: "healthy", production: "access_blocked" }, actions: { planned: 1, applied: 1 } } });
    expect(collectStatus).toHaveBeenNthCalledWith(1, expect.objectContaining({ environment: "development", baseUrl: "https://harness-arena-development-a1b2c3.vercel.app", token: "dev-ops-secret", platform: expect.objectContaining({ deployment: { id: "dpl_development_1", hostname: "harness-arena-development-a1b2c3.vercel.app", ref: "dev", sha: SHA, state: "READY" } }) }));
    expect(collectStatus).toHaveBeenNthCalledWith(2, expect.objectContaining({ environment: "production", baseUrl: "https://harness-arena-psi.vercel.app", token: undefined, platform: expect.objectContaining({ state: "unknown" }) }));
    expect(JSON.stringify(result.log_summary)).not.toMatch(/dev-ops-secret|prod-ops-secret|github-issues-secret|development-cron-secret/);
    expect(github.applyActions).toHaveBeenCalledOnce();
  });

  it("fails closed without creating incidents when label proof or full discovery fails", async () => {
    const collectStatus = vi.fn(), applyActions = vi.fn();
    const labelFailure = await executePassiveMonitorCron({ request: request(), env: runtimeEnv(), collectStatus, github: { verifyLabel: vi.fn().mockRejectedValue(new Error("missing")), discoverIncidents: vi.fn(), applyActions } });
    expect(labelFailure).toMatchObject({ status: 503, body: { ok: false, error: "incident_channel_unavailable" } });
    const discoveryFailure = await executePassiveMonitorCron({ request: request(), env: runtimeEnv(), collectStatus, github: { verifyLabel: vi.fn().mockResolvedValue({ name: "agent-monitor" }), discoverIncidents: vi.fn().mockRejectedValue(new Error("truncated")), applyActions } });
    expect(discoveryFailure).toMatchObject({ status: 503, body: { ok: false, error: "incident_channel_unavailable" } });
    expect(collectStatus).not.toHaveBeenCalled();
    expect(applyActions).not.toHaveBeenCalled();
  });
});
