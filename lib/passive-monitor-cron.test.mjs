import { describe, expect, it, vi } from "vitest";
import {
  DEVELOPMENT_ORIGIN,
  DEVELOPMENT_PROJECT_ID,
  PRODUCTION_ORIGIN,
  createFixedProbeFetch,
  executePassiveMonitorCron,
} from "./passive-monitor-cron.mjs";

const SHA = "a".repeat(40);
const NOW = "2026-08-03T12:00:00.000Z";
const runtimeEnv = (overrides = {}) => ({
  VERCEL_PROJECT_ID: DEVELOPMENT_PROJECT_ID,
  VERCEL_ENV: "production",
  VERCEL_GIT_COMMIT_REF: "dev",
  VERCEL_GIT_COMMIT_SHA: SHA,
  VERCEL_DEPLOYMENT_ID: "dpl_development_1",
  CRON_SECRET: "development-cron-secret-with-32-bytes",
  DEVELOPMENT_OPS_READ_TOKEN: "dev-read-secret",
  PRODUCTION_OPS_READ_TOKEN: "prod-read-secret",
  ...overrides,
});
const request = ({ secret = "development-cron-secret-with-32-bytes", url = `${DEVELOPMENT_ORIGIN}/api/cron/agent-monitor`, method = "GET" } = {}) =>
  new Request(url, { method, headers: secret ? { authorization: `Bearer ${secret}` } : {} });
const status = (environment, verdict = "healthy", overrides = {}) => ({
  schema_version: "agent_ops_status.v1",
  checked_at: NOW,
  environment,
  verdict,
  exit_code: { healthy: 0, degraded: 1, failed: 2, access_blocked: 3 }[verdict],
  health: { sha: environment === "development" ? SHA : null },
  platform: environment === "development" ? { deployment: { id: "dpl_development_1", sha: SHA } } : null,
  findings: verdict === "healthy" ? [] : [{ code: "storage_down", severity: verdict === "degraded" ? "degraded" : "failed", detail: "bounded evidence" }],
  blockers: verdict === "access_blocked" ? [{ code: "ops_access", severity: "access", detail: "unavailable" }] : [],
  ...overrides,
});

describe("Development-only passive Vercel Cron", () => {
  it.each([
    ["wrong project", { VERCEL_PROJECT_ID: "prj_live" }, request(), 404],
    ["wrong runtime", { VERCEL_ENV: "preview" }, request(), 404],
    ["wrong path", {}, request({ url: `${DEVELOPMENT_ORIGIN}/api/cron/reap` }), 404],
    ["wrong host", {}, request({ url: `${PRODUCTION_ORIGIN}/api/cron/agent-monitor` }), 404],
    ["non-GET", {}, request({ method: "POST" }), 404],
    ["missing configured secret", { CRON_SECRET: "" }, request(), 503],
    ["short configured secret", { CRON_SECRET: "short" }, request(), 503],
    ["missing bearer", {}, request({ secret: "" }), 401],
    ["wrong bearer", {}, request({ secret: "wrong-secret-with-at-least-32-bytes" }), 401],
  ])("fails closed for %s before any application probe", async (name, override, cronRequest, expectedStatus) => {
    const collectStatus = vi.fn();
    const result = await executePassiveMonitorCron({ request: cronRequest, env: runtimeEnv(override), collectStatus, now: NOW });
    expect(result.status).toBe(expectedStatus);
    expect(collectStatus).not.toHaveBeenCalled();
    if (expectedStatus === 401 || name.includes("configured secret")) expect(result.events).toEqual([]);
    else expect(result.events).toEqual([expect.objectContaining({ event: "monitor.observation", environment: "development", kind: "monitor_self_failure" })]);
  });

  it.each([
    ["query noise", {}, request({ secret: "", url: `${DEVELOPMENT_ORIGIN}/api/cron/agent-monitor?noise=1` })],
    ["wrong host", {}, request({ secret: "", url: `${PRODUCTION_ORIGIN}/api/cron/agent-monitor` })],
    ["wrong method", {}, request({ secret: "", method: "POST" })],
    ["wrong project", { VERCEL_PROJECT_ID: "prj_live" }, request({ secret: "" })],
  ])("keeps unauthenticated %s traffic out of retained observations", async (_name, overrides, cronRequest) => {
    const collectStatus = vi.fn();
    const result = await executePassiveMonitorCron({ request: cronRequest, env: runtimeEnv(overrides), collectStatus, now: NOW });
    expect(result.status).toBe(401);
    expect(result.events).toEqual([]);
    expect(collectStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["cron/development", { DEVELOPMENT_OPS_READ_TOKEN: "development-cron-secret-with-32-bytes" }, "development-cron-secret-with-32-bytes"],
    ["cron/production", { PRODUCTION_OPS_READ_TOKEN: "development-cron-secret-with-32-bytes" }, "development-cron-secret-with-32-bytes"],
    ["development/production", { PRODUCTION_OPS_READ_TOKEN: "dev-read-secret" }, "development-cron-secret-with-32-bytes"],
  ])("fails closed without probes when %s credentials collide", async (_name, overrides, bearer) => {
    const collectStatus = vi.fn();
    const result = await executePassiveMonitorCron({ request: request({ secret: bearer }), env: runtimeEnv(overrides), collectStatus, now: NOW });
    expect(result).toMatchObject({ status: 503, body: { ok: false } });
    expect(result.events).toEqual([expect.objectContaining({ kind: "monitor_self_failure", failing_checks: [{ code: "credential_separation_failed", severity: "failed" }] })]);
    expect(collectStatus).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/dev-read-secret|development-cron-secret/);
  });

  it("uses only fixed HTTPS origins, separate read tokens, GET-only paths, and immutable Development identity", async () => {
    const collectStatus = vi.fn(async ({ environment }) => status(environment));
    const result = await executePassiveMonitorCron({
      request: request(),
      env: runtimeEnv({ HARNESS_ARENA_DEVELOPMENT_URL: "https://attacker.example", HARNESS_ARENA_PRODUCTION_URL: "https://attacker.example" }),
      collectStatus,
      now: NOW,
    });
    expect(result).toMatchObject({ status: 200, body: { ok: true, observations: [{ environment: "development", verdict: "healthy" }, { environment: "production", verdict: "healthy" }] } });
    expect(collectStatus).toHaveBeenNthCalledWith(1, expect.objectContaining({
      environment: "development", baseUrl: DEVELOPMENT_ORIGIN, token: "dev-read-secret", timeoutMs: 5_000,
      platform: expect.objectContaining({ state: "access_blocked", blockers: [expect.objectContaining({ code: "platform_read_access" })] }),
    }));
    expect(collectStatus).toHaveBeenNthCalledWith(2, expect.objectContaining({
      environment: "production", baseUrl: PRODUCTION_ORIGIN, token: "prod-read-secret", timeoutMs: 5_000,
      platform: expect.objectContaining({ state: "access_blocked" }),
    }));
    expect(JSON.stringify(result)).not.toMatch(/attacker\.example|dev-read-secret|prod-read-secret|development-cron-secret/);
  });

  it("fails Development platform evidence closed when its read-only Vercel credential is absent", async () => {
    const seen = [];
    const collectStatus = vi.fn(async ({ environment, platform }) => {
      seen.push({ environment, platform });
      return status(environment);
    });
    await executePassiveMonitorCron({ request: request(), env: runtimeEnv({ VERCEL_READ_TOKEN: "" }), collectStatus, now: NOW });
    const development = seen.find(({ environment }) => environment === "development").platform;
    expect(development).toMatchObject({
      state: "access_blocked",
      expected_sha: null,
      deployment: null,
      environment: { required_missing: expect.any(Array) },
      logs: { recent_errors: [] },
      cron: { state: "unknown" },
      blockers: [expect.objectContaining({ code: "platform_read_access" })],
    });
  });

  it("collects platform evidence with allowlisted Vercel GETs and never retains its credential", async () => {
    const readToken = "vercel-read-token-that-is-at-least-32-bytes";
    const seen = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const url = new URL(input);
      expect(url.origin).toBe("https://api.vercel.com");
      expect(init.method).toBe("GET");
      expect(init.headers.authorization).toBe(`Bearer ${readToken}`);
      if (url.pathname.startsWith("/v13/deployments/")) return Response.json({
        uid: url.pathname.includes("development") ? "dpl_development_1" : "dpl_production_1",
        url: url.pathname.includes("development") ? "harness-arena-development.vercel.app" : "harness-arena-psi.vercel.app",
        readyState: "READY",
        gitSource: { ref: url.pathname.includes("development") ? "dev" : "main", sha: SHA },
        crons: [{ path: "/api/cron/agent-monitor", schedule: "17,47 * * * *" }],
      });
      if (url.pathname.includes("/env")) return Response.json([
        "OPS_READ_TOKEN", "OPS_READ_CURSOR_SECRET", "AI_GATEWAY_API_KEY", "RUNNER_CALLBACK_SECRET", "BLOB_READ_WRITE_TOKEN",
      ].map((key) => ({ key, target: ["production"], type: "sensitive" })));
      if (url.pathname.includes("/runtime-logs")) return Response.json([]);
      throw new Error(`unexpected Vercel endpoint: ${url.pathname}`);
    });
    const collectStatus = vi.fn(async ({ environment, platform }) => {
      seen.push({ environment, platform });
      return status(environment);
    });
    const result = await executePassiveMonitorCron({ request: request(), env: runtimeEnv({ VERCEL_READ_TOKEN: readToken }), fetchImpl, collectStatus, now: NOW });
    expect(result.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(seen).toEqual(expect.arrayContaining([
      expect.objectContaining({ environment: "development", platform: expect.objectContaining({ state: "ok", expected_sha: SHA, deployment: expect.objectContaining({ state: "READY", ref: "dev", sha: SHA }), environment: expect.objectContaining({ required_missing: [] }), logs: { recent_errors: [] }, cron: { state: "configured", count: 1 } }) }),
      expect.objectContaining({ environment: "production", platform: expect.objectContaining({ state: "ok", expected_sha: null, deployment: expect.objectContaining({ state: "READY", ref: "main", sha: SHA }), environment: expect.objectContaining({ required_missing: [] }), logs: { recent_errors: [] }, cron: { state: "configured", count: 1 } }) }),
    ]));
    expect(JSON.stringify(result)).not.toContain(readToken);
  });

  it.each(["development", "production"])("reports missing %s read access explicitly without probing it", async (missing) => {
    const collectStatus = vi.fn(async ({ environment }) => status(environment));
    const key = missing === "development" ? "DEVELOPMENT_OPS_READ_TOKEN" : "PRODUCTION_OPS_READ_TOKEN";
    const result = await executePassiveMonitorCron({ request: request(), env: runtimeEnv({ [key]: "" }), collectStatus, now: NOW });
    const observation = result.body.observations.find(({ environment }) => environment === missing);
    expect(observation).toMatchObject({ environment: missing, verdict: "access_blocked", kind: "access_blocked", failing_checks: [expect.objectContaining({ code: "ops_access_missing" })] });
    expect(collectStatus).toHaveBeenCalledTimes(1);
    expect(collectStatus.mock.calls[0][0].environment).not.toBe(missing);
  });

  it.each([
    ["healthy", "healthy"],
    ["degraded", "product_failure"],
    ["failed", "product_failure"],
    ["access_blocked", "access_blocked"],
  ])("emits a sanitized %s observation", async (verdict, kind) => {
    const secret = "dev-read-secret";
    const collectStatus = vi.fn(async ({ environment }) => status(environment, verdict, {
      findings: verdict === "healthy" ? [] : [{ code: "storage_down", severity: verdict === "degraded" ? "degraded" : "failed", detail: `authorization: Bearer ${secret}` }],
      request_id: verdict === "healthy" ? "req-safe-01" : secret,
    }));
    const result = await executePassiveMonitorCron({ request: request(), env: runtimeEnv(), collectStatus, now: NOW });
    expect(result.events[0]).toMatchObject({ event: "monitor.observation", timestamp: NOW, environment: "development", verdict, kind, deployment_sha: SHA, failing_checks: expect.any(Array), correlation_ids: expect.any(Array) });
    expect(JSON.stringify(result.events)).not.toContain(secret);
  });

  it("distinguishes collector failure from product failure", async () => {
    const collectStatus = vi.fn(async ({ environment }) => {
      if (environment === "development") throw new Error("transport exploded with dev-read-secret");
      return status(environment, "failed");
    });
    const result = await executePassiveMonitorCron({ request: request(), env: runtimeEnv(), collectStatus, now: NOW });
    expect(result.status).toBe(502);
    expect(result.events).toEqual([
      expect.objectContaining({ environment: "development", verdict: "failed", kind: "monitor_self_failure", failing_checks: [expect.objectContaining({ code: "collector_failed" })] }),
      expect.objectContaining({ environment: "production", verdict: "failed", kind: "product_failure" }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/exploded|dev-read-secret/);
  });

  it.each([
    ["empty", null],
    ["wrong schema", status("development", "healthy", { schema_version: "unknown.v1" })],
    ["wrong environment", status("production")],
    ["invalid verdict", status("development", "healthy", { verdict: "excellent" })],
    ["inconsistent exit", status("development", "healthy", { exit_code: 2 })],
    ["healthy with failing evidence", status("development", "healthy", { findings: [{ code: "storage_down", severity: "failed" }] })],
    ["failed without evidence", status("development", "failed", { findings: [], blockers: [] })],
    ["blocked without blocker evidence", status("development", "access_blocked", { findings: [], blockers: [] })],
  ])("classifies %s collector output as monitor self-failure", async (_name, malformed) => {
    const collectStatus = vi.fn(async ({ environment }) => environment === "development" ? malformed : status("production"));
    const result = await executePassiveMonitorCron({ request: request(), env: runtimeEnv(), collectStatus, now: NOW });
    expect(result.status).toBe(502);
    expect(result.events[0]).toMatchObject({ environment: "development", verdict: "failed", kind: "monitor_self_failure", failing_checks: [{ code: "collector_contract_invalid", severity: "failed" }] });
  });

  it("preserves successful evidence and attributes a deadline only to the timed-out environment", async () => {
    const collectStatus = vi.fn(({ environment }) => environment === "development" ? Promise.resolve(status(environment)) : new Promise(() => {}));
    const started = Date.now();
    const result = await executePassiveMonitorCron({ request: request(), env: runtimeEnv(), collectStatus, now: NOW, deadlineMs: 20 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result).toMatchObject({ status: 502, body: { ok: false } });
    expect(result.events).toEqual([
      expect.objectContaining({ environment: "development", verdict: "healthy", kind: "healthy" }),
      expect.objectContaining({ environment: "production", kind: "monitor_self_failure", failing_checks: [{ code: "monitor_deadline_exceeded", severity: "failed" }] }),
    ]);
  });
});

describe("fixed application probe boundary", () => {
  it("allows only GETs to the exact environment origin and operations paths", async () => {
    const upstream = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const probe = createFixedProbeFetch({ environment: "development", fetchImpl: upstream });
    await probe(`${DEVELOPMENT_ORIGIN}/api/ops/v1/inventory?kind=runs&limit=100`, { method: "GET", redirect: "manual" });
    expect(upstream).toHaveBeenCalledWith(expect.stringContaining("/api/ops/v1/inventory"), expect.objectContaining({ method: "GET", redirect: "manual" }));
    for (const [url, init] of [
      [`${PRODUCTION_ORIGIN}/api/health`, { method: "GET" }],
      [`${DEVELOPMENT_ORIGIN}/api/admin`, { method: "GET" }],
      [`${DEVELOPMENT_ORIGIN}/api/health`, { method: "POST" }],
      [`${DEVELOPMENT_ORIGIN}/api/health`, { method: "GET", redirect: "follow" }],
      [`${DEVELOPMENT_ORIGIN}/api/health`, { method: "GET", body: "mutation" }],
    ]) await expect(probe(url, init)).rejects.toThrow("unsafe_monitor_probe");
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
