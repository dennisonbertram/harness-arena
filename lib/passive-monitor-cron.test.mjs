import { describe, expect, it, vi } from "vitest";
import {
  DEVELOPMENT_ORIGIN,
  DEVELOPMENT_PROJECT_ID,
  PRODUCTION_ORIGIN,
  PRODUCTION_PROJECT_ID,
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
const GENERATED_DEVELOPMENT_HOST = "harness-arena-development-git-dev-unique.vercel.app";
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
const vercelDeployment = (url) => {
  const development = url.pathname.includes("development");
  const alias = development ? "harness-arena-development.vercel.app" : "harness-arena-psi.vercel.app";
  const projectId = development ? DEVELOPMENT_PROJECT_ID : PRODUCTION_PROJECT_ID;
  return {
    id: development ? "dpl_development_1" : "dpl_production_1",
    projectId,
    project: { id: projectId },
    url: development ? "harness-arena-development-unique.vercel.app" : "harness-arena-production-unique.vercel.app",
    alias: [alias],
    readyState: "READY",
    gitSource: { ref: development ? "dev" : "main", sha: SHA },
    crons: [],
  };
};
const requiredEnvironmentRecords = () => [
  "OPS_READ_TOKEN", "OPS_READ_CURSOR_SECRET", "AI_GATEWAY_API_KEY", "RUNNER_CALLBACK_SECRET", "BLOB_READ_WRITE_TOKEN",
].map((key) => ({ key, target: "production", type: "sensitive" }));

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

  it("accepts an authenticated Vercel Cron request on this Development deployment origin", async () => {
    const collectStatus = vi.fn(async ({ environment }) => status(environment));
    const result = await executePassiveMonitorCron({
      request: request({ url: `https://${GENERATED_DEVELOPMENT_HOST}/api/cron/agent-monitor` }),
      env: runtimeEnv({ VERCEL_URL: GENERATED_DEVELOPMENT_HOST }),
      collectStatus,
      now: NOW,
    });

    expect(result).toMatchObject({ status: 200, body: { ok: true } });
    expect(collectStatus).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["without a Vercel deployment identity", { VERCEL_URL: GENERATED_DEVELOPMENT_HOST, VERCEL_DEPLOYMENT_ID: "" }, GENERATED_DEVELOPMENT_HOST],
    ["for the live project hostname", { VERCEL_URL: "harness-arena-psi.vercel.app" }, "harness-arena-psi.vercel.app"],
    ["for an arbitrary Vercel hostname", { VERCEL_URL: "attacker.vercel.app" }, "attacker.vercel.app"],
    ["with an empty Development deployment suffix", { VERCEL_URL: "harness-arena-development-.vercel.app" }, "harness-arena-development-.vercel.app"],
  ])("rejects a generated-origin request %s", async (_name, overrides, host) => {
    const collectStatus = vi.fn();
    const result = await executePassiveMonitorCron({
      request: request({ url: `https://${host}/api/cron/agent-monitor` }),
      env: runtimeEnv(overrides),
      collectStatus,
      now: NOW,
    });

    expect(result.status).toBe(404);
    expect(result.events).toEqual([expect.objectContaining({ kind: "monitor_self_failure", failing_checks: [{ code: "route_guard_failed", severity: "failed" }] })]);
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
      environment: { state: "unknown", records: null, required_missing: null },
      logs: { state: "unknown", recent_errors: null },
      cron: { state: "unknown" },
      blockers: [expect.objectContaining({ code: "platform_read_access" })],
    });
  });

  it("accepts documented Vercel shapes while retaining and verifying the stable deployment alias", async () => {
    const readToken = "vercel-read-token-that-is-at-least-32-bytes";
    const seen = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const url = new URL(input);
      expect(url.origin).toBe("https://api.vercel.com");
      expect(init.method).toBe("GET");
      expect(init.headers.authorization).toBe(`Bearer ${readToken}`);
      if (url.pathname.startsWith("/v13/deployments/")) {
        const development = url.pathname.includes("development");
        const alias = development ? "harness-arena-development.vercel.app" : "harness-arena-psi.vercel.app";
        const projectId = development ? DEVELOPMENT_PROJECT_ID : PRODUCTION_PROJECT_ID;
        return Response.json({
        id: development ? "dpl_development_1" : "dpl_production_1",
        projectId,
        project: { id: projectId },
        url: development ? "harness-arena-development-unique.vercel.app" : "harness-arena-production-unique.vercel.app",
        alias: [alias],
        readyState: "READY",
        gitSource: { ref: development ? "dev" : "main", sha: SHA },
        crons: [
          { path: "/api/cron/reap", schedule: "0 3 * * *" },
          { path: "/api/cron/agent-monitor", schedule: "17 3 * * *" },
        ],
        });
      }
      if (url.pathname.includes("/env")) {
        const envs = [
          "OPS_READ_TOKEN", "OPS_READ_CURSOR_SECRET", "AI_GATEWAY_API_KEY", "RUNNER_CALLBACK_SECRET", "BLOB_READ_WRITE_TOKEN",
        ].map((key, index) => ({ key, target: index % 2 ? ["production"] : "production", type: "sensitive" }));
        return Response.json(url.pathname.includes(DEVELOPMENT_PROJECT_ID) ? { envs } : envs);
      }
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
      expect.objectContaining({ environment: "development", platform: expect.objectContaining({ state: "ok", expected_sha: null, deployment: expect.objectContaining({ hostname: "harness-arena-development.vercel.app", url: "harness-arena-development-unique.vercel.app", id: "dpl_development_1", state: "READY", ref: "dev", sha: SHA }), environment: expect.objectContaining({ state: "observed", required_missing: [] }), logs: { state: "observed", recent_errors: [] }, cron: { state: "configured", count: 2 } }) }),
      expect.objectContaining({ environment: "production", platform: expect.objectContaining({ state: "ok", expected_sha: null, deployment: expect.objectContaining({ hostname: "harness-arena-psi.vercel.app", url: "harness-arena-production-unique.vercel.app", id: "dpl_production_1", state: "READY", ref: "main", sha: SHA }), environment: expect.objectContaining({ state: "observed", required_missing: [] }), logs: { state: "observed", recent_errors: [] }, cron: { state: "configured", count: 2 } }) }),
    ]));
    expect(JSON.stringify(result)).not.toContain(readToken);
  });

  it.each([
    ["deployment", (url) => url.pathname.startsWith("/v13/deployments/")],
    ["environment", (url) => url.pathname.includes("/env")],
    ["logs", (url) => url.pathname.includes("/runtime-logs")],
  ])("keeps %s endpoint failures unknown instead of manufacturing negative evidence", async (failedEndpoint, fails) => {
    const seen = [];
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(input);
      if (fails(url)) return new Response("unavailable", { status: 503 });
      if (url.pathname.startsWith("/v13/deployments/")) return Response.json({
        id: "dpl_development_1",
        projectId: DEVELOPMENT_PROJECT_ID,
        project: { id: DEVELOPMENT_PROJECT_ID },
        url: "harness-arena-development-unique.vercel.app",
        alias: ["harness-arena-development.vercel.app"],
        readyState: "READY",
        gitSource: { ref: "dev", sha: SHA },
        crons: [],
      });
      if (url.pathname.includes("/env")) return Response.json({ envs: [{ key: "OPS_READ_TOKEN", target: "production", type: "sensitive" }] });
      if (url.pathname.includes("/runtime-logs")) return Response.json([{ level: "error", responseStatusCode: 500 }]);
      throw new Error(`unexpected Vercel endpoint: ${url.pathname}`);
    });
    const collectStatus = vi.fn(async ({ environment, platform }) => {
      if (environment === "development") seen.push(platform);
      return status(environment);
    });
    await executePassiveMonitorCron({ request: request(), env: runtimeEnv({ VERCEL_READ_TOKEN: "vercel-read-token-that-is-at-least-32-bytes" }), fetchImpl, collectStatus, now: NOW });
    expect(seen[0]).toMatchObject({ state: "access_blocked", blockers: [expect.objectContaining({ code: "platform_read_access" })] });
    if (failedEndpoint === "deployment") {
      expect(seen[0]).toMatchObject({
        deployment: null,
        environment: { state: "observed", required_missing: ["OPS_READ_CURSOR_SECRET", "AI_GATEWAY_API_KEY", "RUNNER_CALLBACK_SECRET", "BLOB_READ_WRITE_TOKEN"] },
        logs: { state: "unknown", recent_errors: null },
        cron: { state: "unknown" },
      });
    } else if (failedEndpoint === "environment") {
      expect(seen[0].environment).toEqual({ state: "unknown", target: "production", records: null, required_missing: null });
      expect(seen[0]).toMatchObject({ logs: { state: "observed", recent_errors: [{}] }, cron: { state: "missing", count: 0 } });
    } else {
      expect(seen[0].logs).toEqual({ state: "unknown", recent_errors: null });
      expect(seen[0]).toMatchObject({
        environment: { state: "observed", required_missing: ["OPS_READ_CURSOR_SECRET", "AI_GATEWAY_API_KEY", "RUNNER_CALLBACK_SECRET", "BLOB_READ_WRITE_TOKEN"] },
        cron: { state: "missing", count: 0 },
      });
    }
  });

  it("rejects deployment evidence when the alias resolves outside the fixed project identity", async () => {
    const seen = [];
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(input);
      if (url.pathname.startsWith("/v13/deployments/")) return Response.json({
        id: "dpl_wrong_project",
        projectId: PRODUCTION_PROJECT_ID,
        project: { id: PRODUCTION_PROJECT_ID },
        url: "attacker-project-unique.vercel.app",
        alias: ["harness-arena-development.vercel.app"],
        readyState: "READY",
        gitSource: { ref: "dev", sha: SHA },
        crons: [
          { path: "/api/cron/reap", schedule: "0 3 * * *" },
          { path: "/api/cron/agent-monitor", schedule: "17 3 * * *" },
        ],
      });
      if (url.pathname.includes("/env")) return Response.json({ envs: [] });
      if (url.pathname.includes("/runtime-logs")) return Response.json([]);
      throw new Error(`unexpected Vercel endpoint: ${url.pathname}`);
    });
    const collectStatus = vi.fn(async ({ environment, platform }) => {
      if (environment === "development") seen.push(platform);
      return status(environment);
    });
    await executePassiveMonitorCron({ request: request(), env: runtimeEnv({ VERCEL_READ_TOKEN: "vercel-read-token-that-is-at-least-32-bytes" }), fetchImpl, collectStatus, now: NOW });
    expect(seen[0]).toMatchObject({
      state: "access_blocked",
      deployment: null,
      logs: { state: "unknown", recent_errors: null },
      cron: { state: "unknown", count: null },
      blockers: [expect.objectContaining({ code: "platform_evidence_invalid" })],
    });
  });

  it.each([
    ["singleton", { level: "error", responseStatusCode: 500 }],
    ["array", [{ level: "error", responseStatusCode: 500 }]],
    ["data wrapper", { data: [{ level: "error", responseStatusCode: 500 }] }],
  ])("accepts the %s runtime log container and counts its error", async (_name, logBody) => {
    const seen = [];
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(input);
      if (url.pathname.startsWith("/v13/deployments/")) return Response.json(vercelDeployment(url));
      if (url.pathname.includes("/env")) return Response.json({ envs: requiredEnvironmentRecords() });
      if (url.pathname.includes("/runtime-logs")) return Response.json(logBody);
      throw new Error(`unexpected Vercel endpoint: ${url.pathname}`);
    });
    const collectStatus = vi.fn(async ({ environment, platform }) => {
      if (environment === "development") seen.push(platform);
      return status(environment);
    });
    await executePassiveMonitorCron({ request: request(), env: runtimeEnv({ VERCEL_READ_TOKEN: "vercel-read-token-that-is-at-least-32-bytes" }), fetchImpl, collectStatus, now: NOW });
    expect(seen[0]).toMatchObject({ state: "ok", logs: { state: "observed", recent_errors: [{}] }, blockers: [] });
  });

  it.each([
    ["unrecognized object", {}],
    ["malformed data wrapper", { data: "not-an-array" }],
    ["null array entry", [null]],
    ["malformed log entry", [{ level: 7, responseStatusCode: 500 }]],
    ["malformed status", [{ level: "error", responseStatusCode: "500" }]],
  ])("rejects %s runtime log evidence instead of observing an empty error list", async (_name, logBody) => {
    const seen = [];
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(input);
      if (url.pathname.startsWith("/v13/deployments/")) return Response.json(vercelDeployment(url));
      if (url.pathname.includes("/env")) return Response.json({ envs: requiredEnvironmentRecords() });
      if (url.pathname.includes("/runtime-logs")) return Response.json(logBody);
      throw new Error(`unexpected Vercel endpoint: ${url.pathname}`);
    });
    const collectStatus = vi.fn(async ({ environment, platform }) => {
      if (environment === "development") seen.push(platform);
      return status(environment);
    });
    await executePassiveMonitorCron({ request: request(), env: runtimeEnv({ VERCEL_READ_TOKEN: "vercel-read-token-that-is-at-least-32-bytes" }), fetchImpl, collectStatus, now: NOW });
    expect(seen[0]).toMatchObject({
      state: "access_blocked",
      logs: { state: "unknown", recent_errors: null },
      blockers: [expect.objectContaining({ code: "platform_evidence_invalid" })],
    });
  });

  it.each([
    ["null entry", { envs: [null] }],
    ["non-string key", { envs: [{ key: 7, target: "production", type: "sensitive" }] }],
    ["scalar target", { envs: [{ key: "OPS_READ_TOKEN", target: 7, type: "sensitive" }] }],
    ["array target", { envs: [{ key: "OPS_READ_TOKEN", target: ["production", 7], type: "sensitive" }] }],
    ["unknown target", { envs: [{ key: "OPS_READ_TOKEN", target: "staging", type: "sensitive" }] }],
    ["non-string type", { envs: [{ key: "OPS_READ_TOKEN", target: "production", type: 7 }] }],
  ])("rejects malformed environment %s instead of manufacturing required_missing", async (_name, environmentBody) => {
    const seen = [];
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(input);
      if (url.pathname.startsWith("/v13/deployments/")) return Response.json(vercelDeployment(url));
      if (url.pathname.includes("/env")) return Response.json(environmentBody);
      if (url.pathname.includes("/runtime-logs")) return Response.json([]);
      throw new Error(`unexpected Vercel endpoint: ${url.pathname}`);
    });
    const collectStatus = vi.fn(async ({ environment, platform }) => {
      if (environment === "development") seen.push(platform);
      return status(environment);
    });
    await executePassiveMonitorCron({ request: request(), env: runtimeEnv({ VERCEL_READ_TOKEN: "vercel-read-token-that-is-at-least-32-bytes" }), fetchImpl, collectStatus, now: NOW });
    expect(seen[0]).toMatchObject({
      state: "access_blocked",
      environment: { state: "unknown", records: null, required_missing: null },
      blockers: [expect.objectContaining({ code: "platform_evidence_invalid" })],
    });
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
