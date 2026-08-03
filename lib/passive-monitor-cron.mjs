import { createHash, timingSafeEqual } from "node:crypto";
import { collectAgentOpsStatus, redactSensitive } from "../scripts/ops/agent-status.mjs";

export const DEVELOPMENT_PROJECT_ID = "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA";
export const PRODUCTION_PROJECT_ID = "prj_f4ppu0xpO0LZeHOAH99RHotVbwyo";
export const DEVELOPMENT_ORIGIN = "https://harness-arena-development.vercel.app";
export const PRODUCTION_ORIGIN = "https://harness-arena-psi.vercel.app";

const CRON_PATH = "/api/cron/agent-monitor";
const TIMEOUT_MS = 5_000;
const DEADLINE_MS = 12_000;
const MIN_SECRET_LENGTH = 32;
const VERCEL_API_ORIGIN = "https://api.vercel.com";
const VERCEL_TEAM_ID = "team_cwyLpng8LCwWgINdiQ27hHYa";
const REQUIRED_ENVIRONMENT = ["OPS_READ_TOKEN", "OPS_READ_CURSOR_SECRET", "AI_GATEWAY_API_KEY", "RUNNER_CALLBACK_SECRET", "BLOB_READ_WRITE_TOKEN"];
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_DEPLOYMENT_ID = /^dpl_[A-Za-z0-9_]+$/;
const ALLOWED_PATHS = new Set(["/api/health", "/api/ops/v1", "/api/ops/v1/summary", "/api/ops/v1/inventory", "/api/ops/v1/read"]);

function digest(value) {
  return createHash("sha256").update(String(value ?? "")).digest();
}

function exactBearer(actual, expected) {
  if (typeof expected !== "string" || expected.length < MIN_SECRET_LENGTH) return false;
  return timingSafeEqual(digest(actual), digest(`Bearer ${expected}`));
}

function credentialsSeparated(values) {
  const secrets = values.map((value) => typeof value === "string" && value ? digest(value) : null);
  let separated = true;
  for (let left = 0; left < secrets.length; left += 1) {
    for (let right = left + 1; right < secrets.length; right += 1) {
      if (secrets[left] && secrets[right]) separated = !timingSafeEqual(secrets[left], secrets[right]) && separated;
    }
  }
  return separated;
}

function safeCode(value, fallback) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function fixedOrigin(environment) {
  if (environment === "development") return DEVELOPMENT_ORIGIN;
  if (environment === "production") return PRODUCTION_ORIGIN;
  throw new Error("invalid_monitor_environment");
}

export function createFixedProbeFetch({ environment, fetchImpl = globalThis.fetch, deadlineSignal } = {}) {
  const origin = fixedOrigin(environment);
  if (typeof fetchImpl !== "function") throw new Error("invalid_monitor_fetch");
  return async (input, init = {}) => {
    let url;
    try { url = new URL(typeof input === "string" || input instanceof URL ? input : input?.url); }
    catch { throw new Error("unsafe_monitor_probe"); }
    if (url.origin !== origin || !ALLOWED_PATHS.has(url.pathname) || url.username || url.password || url.hash) throw new Error("unsafe_monitor_probe");
    if (init.method !== "GET" || init.redirect !== "manual" || init.body !== undefined) throw new Error("unsafe_monitor_probe");
    if (deadlineSignal?.aborted) throw new DOMException("monitor deadline exceeded", "AbortError");
    const signals = [init.signal, deadlineSignal].filter(Boolean);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    return fetchImpl(url.toString(), { ...init, ...(signal ? { signal } : {}) });
  };
}

function unavailablePlatform(environment, detail) {
  return {
    state: "access_blocked",
    expected_sha: null,
    deployment: null,
    environment: { target: "production", records: [], required_missing: [...REQUIRED_ENVIRONMENT] },
    logs: { recent_errors: [] },
    cron: { state: "unknown", count: null },
    blockers: [{ code: "platform_read_access", detail }],
    command_provenance: [],
  };
}

function boundedAge(createdAt, now) {
  const created = typeof createdAt === "number" ? createdAt : Date.parse(createdAt ?? "");
  const current = Date.parse(now);
  return Number.isFinite(created) && Number.isFinite(current) ? Math.max(0, current - created) : null;
}

function deploymentEvidence(value, hostname, now) {
  const source = value?.gitSource ?? {}, meta = value?.meta ?? {};
  const id = typeof value?.uid === "string" ? value.uid : typeof value?.id === "string" ? value.id : null;
  const sha = typeof source.sha === "string" ? source.sha : typeof meta.githubCommitSha === "string" ? meta.githubCommitSha : null;
  const ref = typeof source.ref === "string" ? source.ref : typeof meta.githubCommitRef === "string" ? meta.githubCommitRef : null;
  const returnedHostname = typeof value?.url === "string" ? value.url : null;
  return {
    hostname: returnedHostname === hostname ? returnedHostname : null,
    id: SAFE_DEPLOYMENT_ID.test(id ?? "") ? id : null,
    state: typeof value?.readyState === "string" ? value.readyState : typeof value?.state === "string" ? value.state : null,
    created_at: value?.createdAt ?? value?.created ?? null,
    age_ms: boundedAge(value?.createdAt ?? value?.created, now),
    ref,
    sha: /^[0-9a-f]{40}$/i.test(sha ?? "") ? sha.toLowerCase() : null,
    git_dirty: source.dirty === true || source.dirty === "true" || meta.gitDirty === true || meta.gitDirty === "true",
  };
}

function environmentEvidence(value) {
  const records = Array.isArray(value) ? value.slice(0, 500).flatMap((item) => {
    if (!item || typeof item !== "object" || typeof item.key !== "string") return [];
    return [{ name: item.key, targets: Array.isArray(item.target) ? item.target.filter((target) => typeof target === "string") : [], type: typeof item.type === "string" ? item.type : "unknown" }];
  }) : [];
  const present = new Set(records.filter((item) => item.targets.length === 0 || item.targets.includes("production")).map((item) => item.name));
  return { target: "production", records, required_missing: REQUIRED_ENVIRONMENT.filter((name) => !present.has(name)) };
}

function runtimeErrors(value) {
  const items = Array.isArray(value) ? value : [];
  return { recent_errors: items.filter((item) => item && typeof item === "object" && (String(item.level ?? "").toLowerCase() === "error" || Number(item.statusCode ?? item.responseStatusCode) >= 500)).slice(-20).map(() => ({})) };
}

function requestSignal(deadlineSignal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return deadlineSignal ? AbortSignal.any([timeout, deadlineSignal]) : timeout;
}

async function vercelGetResponse(fetchImpl, pathname, token, deadlineSignal) {
  const url = new URL(pathname, VERCEL_API_ORIGIN);
  if (url.origin !== VERCEL_API_ORIGIN || !url.pathname.startsWith("/v")) throw new Error("unsafe_vercel_read");
  const response = await fetchImpl(url.toString(), { method: "GET", redirect: "manual", headers: { authorization: `Bearer ${token}` }, signal: requestSignal(deadlineSignal) });
  if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) throw new Error(`vercel_read_http_${response?.status ?? "invalid"}`);
  return response;
}

async function vercelGetJson(fetchImpl, pathname, token, deadlineSignal) {
  return (await vercelGetResponse(fetchImpl, pathname, token, deadlineSignal)).json();
}

async function vercelGetRuntimeLogs(fetchImpl, pathname, token, deadlineSignal) {
  const response = await vercelGetResponse(fetchImpl, pathname, token, deadlineSignal);
  const text = await response.text();
  if (Buffer.byteLength(text) > 1_000_000) throw new Error("vercel_runtime_logs_too_large");
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
  } catch {
    return text.split(/\r?\n/).flatMap((line) => {
      try {
        const value = JSON.parse(line.startsWith("data:") ? line.slice(5).trim() : line);
        return value && typeof value === "object" ? [value] : [];
      } catch { return []; }
    });
  }
}

async function observePlatform({ environment, env, fetchImpl, now, deadlineSignal }) {
  const token = env?.VERCEL_READ_TOKEN;
  if (typeof token !== "string" || token.length < MIN_SECRET_LENGTH) return unavailablePlatform(environment, "read-only Vercel access is not configured");
  const development = environment === "development";
  const hostname = new URL(fixedOrigin(environment)).hostname;
  const projectId = development ? DEVELOPMENT_PROJECT_ID : PRODUCTION_PROJECT_ID;
  const inspectPath = `/v13/deployments/${hostname}?withGitRepoInfo=true&teamId=${VERCEL_TEAM_ID}`;
  const environmentPath = `/v10/projects/${projectId}/env?teamId=${VERCEL_TEAM_ID}`;
  const [deploymentResult, environmentResult] = await Promise.allSettled([
    vercelGetJson(fetchImpl, inspectPath, token, deadlineSignal),
    vercelGetJson(fetchImpl, environmentPath, token, deadlineSignal),
  ]);
  const blockers = [];
  if (deploymentResult.status !== "fulfilled") blockers.push({ code: "platform_read_access", detail: "deployment metadata endpoint is unavailable" });
  if (environmentResult.status !== "fulfilled") blockers.push({ code: "platform_read_access", detail: "environment metadata endpoint is unavailable" });
  const deployment = deploymentResult.status === "fulfilled" ? deploymentEvidence(deploymentResult.value, hostname, now) : null;
  let logs = { recent_errors: [] };
  if (deployment?.id) {
    try {
      logs = runtimeErrors(await vercelGetRuntimeLogs(fetchImpl, `/v1/projects/${projectId}/deployments/${deployment.id}/runtime-logs?teamId=${VERCEL_TEAM_ID}`, token, deadlineSignal));
    } catch { blockers.push({ code: "platform_read_access", detail: "runtime logs endpoint is unavailable" }); }
  } else if (!blockers.length) blockers.push({ code: "platform_read_access", detail: "deployment identity is unavailable" });
  const inspectedCrons = deploymentResult.status === "fulfilled" && Array.isArray(deploymentResult.value?.crons) ? deploymentResult.value.crons : null;
  return {
    state: blockers.length ? "access_blocked" : "ok",
    expected_sha: development && /^[0-9a-f]{40}$/i.test(env?.VERCEL_GIT_COMMIT_SHA ?? "") ? env.VERCEL_GIT_COMMIT_SHA.toLowerCase() : null,
    deployment,
    environment: environmentResult.status === "fulfilled" ? environmentEvidence(environmentResult.value) : { target: "production", records: [], required_missing: [...REQUIRED_ENVIRONMENT] },
    logs,
    cron: { state: inspectedCrons === null ? "unknown" : inspectedCrons.length ? "configured" : "missing", count: inspectedCrons?.length ?? null },
    blockers,
    command_provenance: ["deployment", "environment", deployment?.id ? "runtime_logs" : null].filter(Boolean).map((endpoint) => ({ binary: "vercel-api", argv: [endpoint], exit_code: null, state: "read_only" })),
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

function validCheck(item, allowedSeverities) {
  return item && typeof item === "object" && !Array.isArray(item)
    && typeof item.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(item.code)
    && allowedSeverities.includes(item.severity);
}

function validCollectorResult(status, environment) {
  try {
    if (!status || typeof status !== "object" || Array.isArray(status)) return false;
    if (status.schema_version !== "agent_ops_status.v1" || status.environment !== environment) return false;
    if (!Number.isFinite(Date.parse(status.checked_at ?? ""))) return false;
    const exits = { healthy: 0, degraded: 1, failed: 2, access_blocked: 3 };
    if (!Object.hasOwn(exits, status.verdict) || status.exit_code !== exits[status.verdict]) return false;
    if (!Object.hasOwn(status, "health") || !Object.hasOwn(status, "platform") || !Array.isArray(status.findings) || !Array.isArray(status.blockers)) return false;
    if (!status.findings.every((item) => validCheck(item, ["degraded", "failed"])) || !status.blockers.every((item) => validCheck(item, ["access"]))) return false;
    if (status.verdict === "healthy") return status.findings.length === 0 && status.blockers.length === 0;
    if (status.verdict === "degraded") return status.blockers.length === 0 && status.findings.some(({ severity }) => severity === "degraded") && status.findings.every(({ severity }) => severity !== "failed");
    if (status.verdict === "failed") return status.blockers.length === 0 && status.findings.some(({ severity }) => severity === "failed");
    return status.blockers.some(({ severity }) => severity === "access");
  } catch { return false; }
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

async function collectEnvironment({ environment, token, env, fetchImpl, collectStatus, now, knownSecrets, deadlineSignal }) {
  if (typeof token !== "string" || !token) return accessBlocked(environment, now, knownSecrets);
  try {
    const platform = await observePlatform({ environment, env, fetchImpl, now, deadlineSignal });
    const status = await collectStatus({
      environment,
      baseUrl: fixedOrigin(environment),
      token,
      fetchImpl: createFixedProbeFetch({ environment, fetchImpl, deadlineSignal }),
      now,
      timeoutMs: TIMEOUT_MS,
      platform,
    });
    if (!validCollectorResult(status, environment)) return monitorFailure(environment, now, "collector_contract_invalid", knownSecrets);
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

export async function executePassiveMonitorCron({ request, env = process.env, fetchImpl = globalThis.fetch, collectStatus = collectAgentOpsStatus, now = new Date().toISOString(), deadlineMs: requestedDeadline } = {}) {
  const requestUrl = (() => { try { return request instanceof Request ? new URL(request.url) : null; } catch { return null; } })();
  // Authenticate before retaining any route/runtime guard observation. Public
  // malformed traffic must not be able to fabricate monitor failures.
  if (typeof env?.CRON_SECRET !== "string" || env.CRON_SECRET.length < MIN_SECRET_LENGTH) return { status: 503, body: { ok: false, error: "cron_unavailable" }, events: [] };
  if (!request || !exactBearer(request.headers?.get?.("authorization") ?? null, env.CRON_SECRET)) return { status: 401, body: { ok: false, error: "unauthorized" }, events: [] };
  if (env?.VERCEL_PROJECT_ID !== DEVELOPMENT_PROJECT_ID || env?.VERCEL_ENV !== "production") return guardFailure(404, "runtime_guard_failed", now, env);
  if (!requestUrl || request.method !== "GET" || requestUrl.origin !== DEVELOPMENT_ORIGIN || requestUrl.pathname !== CRON_PATH || requestUrl.search || requestUrl.hash) return guardFailure(404, "route_guard_failed", now, env);

  const knownSecrets = [env.CRON_SECRET, env.DEVELOPMENT_OPS_READ_TOKEN, env.PRODUCTION_OPS_READ_TOKEN, env.VERCEL_READ_TOKEN].filter(Boolean);
  if (!credentialsSeparated([env.CRON_SECRET, env.DEVELOPMENT_OPS_READ_TOKEN, env.PRODUCTION_OPS_READ_TOKEN, env.VERCEL_READ_TOKEN])) return guardFailure(503, "credential_separation_failed", now, env);

  const deadlineMs = Number.isSafeInteger(requestedDeadline) && requestedDeadline > 0 && requestedDeadline <= DEADLINE_MS ? requestedDeadline : DEADLINE_MS;
  const deadlineController = new AbortController();
  let deadlineTimer;
  const collection = Promise.all([
    collectEnvironment({ environment: "development", token: env.DEVELOPMENT_OPS_READ_TOKEN, env, fetchImpl, collectStatus, now, knownSecrets, deadlineSignal: deadlineController.signal }),
    collectEnvironment({ environment: "production", token: env.PRODUCTION_OPS_READ_TOKEN, env, fetchImpl, collectStatus, now, knownSecrets, deadlineSignal: deadlineController.signal }),
  ]);
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => { deadlineController.abort(); resolve(null); }, deadlineMs);
    deadlineTimer.unref?.();
  });
  const events = await Promise.race([collection, deadline]);
  clearTimeout(deadlineTimer);
  if (!events) {
    collection.catch(() => {});
    return result(504, [monitorFailure("development", now, "monitor_deadline_exceeded", knownSecrets)]);
  }
  return result(events.some(({ kind }) => kind === "monitor_self_failure") ? 502 : 200, events);
}
