import { createHash, timingSafeEqual } from "node:crypto";
import { collectAgentOpsStatus, redactSensitive } from "../scripts/ops/agent-status.mjs";

export const DEVELOPMENT_PROJECT_ID = "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA";
export const DEVELOPMENT_ORIGIN = "https://harness-arena-development.vercel.app";
export const PRODUCTION_ORIGIN = "https://harness-arena-psi.vercel.app";

const CRON_PATH = "/api/cron/agent-monitor";
const TIMEOUT_MS = 5_000;
const MIN_SECRET_LENGTH = 32;
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ALLOWED_PATHS = new Set(["/api/health", "/api/ops/v1", "/api/ops/v1/summary", "/api/ops/v1/inventory", "/api/ops/v1/read"]);

function digest(value) {
  return createHash("sha256").update(String(value ?? "")).digest();
}

function exactBearer(actual, expected) {
  if (typeof expected !== "string" || expected.length < MIN_SECRET_LENGTH) return false;
  return timingSafeEqual(digest(actual), digest(`Bearer ${expected}`));
}

function safeCode(value, fallback) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function fixedOrigin(environment) {
  if (environment === "development") return DEVELOPMENT_ORIGIN;
  if (environment === "production") return PRODUCTION_ORIGIN;
  throw new Error("invalid_monitor_environment");
}

export function createFixedProbeFetch({ environment, fetchImpl = globalThis.fetch } = {}) {
  const origin = fixedOrigin(environment);
  if (typeof fetchImpl !== "function") throw new Error("invalid_monitor_fetch");
  return async (input, init = {}) => {
    let url;
    try { url = new URL(typeof input === "string" || input instanceof URL ? input : input?.url); }
    catch { throw new Error("unsafe_monitor_probe"); }
    if (url.origin !== origin || !ALLOWED_PATHS.has(url.pathname) || url.username || url.password || url.hash) throw new Error("unsafe_monitor_probe");
    if (init.method !== "GET" || init.redirect !== "manual" || init.body !== undefined) throw new Error("unsafe_monitor_probe");
    return fetchImpl(url.toString(), init);
  };
}

function developmentPlatform(env) {
  const sha = /^[0-9a-f]{40}$/.test(env.VERCEL_GIT_COMMIT_SHA ?? "") ? env.VERCEL_GIT_COMMIT_SHA : null;
  const deploymentId = /^dpl_[A-Za-z0-9_]+$/.test(env.VERCEL_DEPLOYMENT_ID ?? "") ? env.VERCEL_DEPLOYMENT_ID : null;
  return {
    state: "ready",
    expected_sha: sha,
    deployment: {
      hostname: new URL(DEVELOPMENT_ORIGIN).hostname,
      id: deploymentId,
      state: "READY",
      created_at: null,
      age_ms: null,
      ref: env.VERCEL_GIT_COMMIT_REF === "dev" ? "dev" : null,
      sha,
      git_dirty: null,
    },
    environment: { target: "production", records: [], required_missing: [] },
    logs: { recent_errors: [] },
    cron: { state: "configured", count: 1 },
    blockers: [],
    command_provenance: [{ binary: "vercel-runtime", argv: [], exit_code: 0, state: "ok" }],
  };
}

function productionPlatform() {
  return {
    state: "access_blocked",
    expected_sha: null,
    deployment: null,
    environment: { target: "production", records: [], required_missing: [] },
    logs: { recent_errors: [] },
    cron: { state: "unknown", count: null },
    blockers: [{ code: "platform_read_access", detail: "production platform evidence is unavailable to the Development runtime" }],
    command_provenance: [],
  };
}

function correlationIds(status) {
  const candidates = [status?.request_id, status?.trace_id];
  for (const item of status?.platform?.logs?.recent_errors ?? []) candidates.push(item?.request_id, item?.trace_id);
  return [...new Set(candidates.filter((value) => typeof value === "string" && SAFE_CORRELATION_ID.test(value)))].slice(0, 20);
}

function checkList(status) {
  const checks = [];
  for (const item of [...(status?.findings ?? []), ...(status?.blockers ?? [])].slice(0, 50)) {
    checks.push({
      code: safeCode(item?.code, "unknown_check"),
      severity: ["degraded", "failed", "access"].includes(item?.severity) ? item.severity : "failed",
    });
  }
  return checks;
}

function eventFromStatus(status, environment, timestamp, knownSecrets) {
  const verdict = ["healthy", "degraded", "failed", "access_blocked"].includes(status?.verdict) ? status.verdict : "failed";
  const event = {
    event: "monitor.observation",
    timestamp,
    environment,
    verdict,
    kind: verdict === "healthy" ? "healthy" : verdict === "access_blocked" ? "access_blocked" : "product_failure",
    deployment_sha: typeof status?.platform?.deployment?.sha === "string" ? status.platform.deployment.sha : typeof status?.health?.sha === "string" ? status.health.sha : null,
    failing_checks: checkList(status),
    correlation_ids: correlationIds(status),
  };
  return redactSensitive(event, knownSecrets);
}

function accessBlocked(environment, timestamp, knownSecrets) {
  return redactSensitive({
    event: "monitor.observation",
    timestamp,
    environment,
    verdict: "access_blocked",
    kind: "access_blocked",
    deployment_sha: null,
    failing_checks: [{ code: "ops_access_missing", severity: "access" }],
    correlation_ids: [],
  }, knownSecrets);
}

function monitorFailure(environment, timestamp, code, knownSecrets) {
  return redactSensitive({
    event: "monitor.observation",
    timestamp,
    environment,
    verdict: "failed",
    kind: "monitor_self_failure",
    deployment_sha: null,
    failing_checks: [{ code: safeCode(code, "collector_failed"), severity: "failed" }],
    correlation_ids: [],
  }, knownSecrets);
}

async function collectEnvironment({ environment, token, env, fetchImpl, collectStatus, now, knownSecrets }) {
  if (typeof token !== "string" || !token) return accessBlocked(environment, now, knownSecrets);
  try {
    const status = await collectStatus({
      environment,
      baseUrl: fixedOrigin(environment),
      token,
      fetchImpl: createFixedProbeFetch({ environment, fetchImpl }),
      now,
      timeoutMs: TIMEOUT_MS,
      platform: environment === "development" ? developmentPlatform(env) : productionPlatform(),
    });
    return eventFromStatus(status, environment, now, knownSecrets);
  } catch {
    return monitorFailure(environment, now, "collector_failed", knownSecrets);
  }
}

function result(status, events) {
  return {
    status,
    body: {
      ok: status === 200,
      observations: events.map(({ environment, verdict, kind, failing_checks }) => ({ environment, verdict, kind, failing_checks })),
    },
    events,
  };
}

function guardFailure(status, code, now, env) {
  return result(status, [monitorFailure("development", now, code, [env?.CRON_SECRET, env?.DEVELOPMENT_OPS_READ_TOKEN, env?.PRODUCTION_OPS_READ_TOKEN].filter(Boolean))]);
}

export async function executePassiveMonitorCron({ request, env = process.env, fetchImpl = globalThis.fetch, collectStatus = collectAgentOpsStatus, now = new Date().toISOString() } = {}) {
  const requestUrl = (() => { try { return request instanceof Request ? new URL(request.url) : null; } catch { return null; } })();
  if (env?.VERCEL_PROJECT_ID !== DEVELOPMENT_PROJECT_ID || env?.VERCEL_ENV !== "production") return guardFailure(404, "runtime_guard_failed", now, env);
  if (!requestUrl || request.method !== "GET" || requestUrl.origin !== DEVELOPMENT_ORIGIN || requestUrl.pathname !== CRON_PATH || requestUrl.search || requestUrl.hash) return guardFailure(404, "route_guard_failed", now, env);
  if (typeof env.CRON_SECRET !== "string" || env.CRON_SECRET.length < MIN_SECRET_LENGTH) return guardFailure(503, "cron_secret_unavailable", now, env);
  if (!exactBearer(request.headers.get("authorization"), env.CRON_SECRET)) return guardFailure(401, "cron_auth_failed", now, env);

  const knownSecrets = [env.CRON_SECRET, env.DEVELOPMENT_OPS_READ_TOKEN, env.PRODUCTION_OPS_READ_TOKEN].filter(Boolean);
  const events = await Promise.all([
    collectEnvironment({ environment: "development", token: env.DEVELOPMENT_OPS_READ_TOKEN, env, fetchImpl, collectStatus, now, knownSecrets }),
    collectEnvironment({ environment: "production", token: env.PRODUCTION_OPS_READ_TOKEN, env, fetchImpl, collectStatus, now, knownSecrets }),
  ]);
  return result(events.some(({ kind }) => kind === "monitor_self_failure") ? 502 : 200, events);
}
