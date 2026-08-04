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
const SAFE_HOSTNAME = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/;
const SAFE_DEVELOPMENT_DEPLOYMENT_HOST = /^harness-arena-development-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.vercel\.app$/;
const ENVIRONMENT_TARGETS = new Set(["development", "preview", "production"]);
const ENVIRONMENT_TYPES = new Set(["encrypted", "plain", "secret", "sensitive", "system"]);
const RUNTIME_LOG_LEVELS = new Set(["debug", "error", "fatal", "info", "trace", "warning"]);
const ALLOWED_PATHS = new Set(["/api/health", "/api/ops/v1", "/api/ops/v1/summary", "/api/ops/v1/inventory", "/api/ops/v1/read"]);
const INVALID_PLATFORM_EVIDENCE = new WeakSet();

function digest(value) {
  return createHash("sha256").update(String(value ?? "")).digest();
}

function exactBearer(actual, expected) {
  if (typeof expected !== "string" || expected.length < MIN_SECRET_LENGTH) return false;
  return timingSafeEqual(digest(actual), digest(`Bearer ${expected}`));
}

function invalidPlatformEvidence(message) {
  const error = new Error(message);
  INVALID_PLATFORM_EVIDENCE.add(error);
  return error;
}

function isInvalidPlatformEvidence(error) {
  return error && (typeof error === "object" || typeof error === "function") && INVALID_PLATFORM_EVIDENCE.has(error);
}

function platformReadBlocker(error, accessDetail, invalidDetail) {
  return isInvalidPlatformEvidence(error)
    ? { code: "platform_evidence_invalid", detail: invalidDetail }
    : { code: "platform_read_access", detail: accessDetail };
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

function developmentDeploymentOrigin(env) {
  const hostname = env?.VERCEL_URL;
  if (typeof hostname !== "string"
    || !SAFE_DEPLOYMENT_ID.test(env?.VERCEL_DEPLOYMENT_ID ?? "")
    || !SAFE_DEVELOPMENT_DEPLOYMENT_HOST.test(hostname)
    || !SAFE_HOSTNAME.test(hostname)) return null;
  try {
    const origin = new URL(`https://${hostname}`);
    return origin.hostname === hostname && origin.protocol === "https:" && origin.port === "" ? origin.origin : null;
  } catch { return null; }
}

function trustedCronOrigin(requestUrl, env) {
  return requestUrl.origin === DEVELOPMENT_ORIGIN || requestUrl.origin === developmentDeploymentOrigin(env);
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

function unknownEnvironment() {
  return { state: "unknown", target: "production", records: null, required_missing: null };
}

function unknownLogs() {
  return { state: "unknown", recent_errors: null };
}

function unavailablePlatform(detail) {
  return {
    state: "access_blocked",
    expected_sha: null,
    deployment: null,
    environment: unknownEnvironment(),
    logs: unknownLogs(),
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

function stringArray(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

function deploymentEvidence(value, hostname, projectId, now) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_deployment_evidence");
  const source = value?.gitSource ?? {}, meta = value?.meta ?? {};
  const id = typeof value?.uid === "string" ? value.uid : typeof value?.id === "string" ? value.id : null;
  if (!SAFE_DEPLOYMENT_ID.test(id ?? "")) throw new Error("invalid_deployment_identity");
  const observedProjectIds = [value?.projectId, value?.project?.id].filter((candidate) => typeof candidate === "string");
  if (!observedProjectIds.length || observedProjectIds.some((candidate) => candidate !== projectId)) throw new Error("invalid_project_identity");
  const aliases = [...stringArray(value?.alias), ...stringArray(value?.aliases), ...stringArray(value?.automaticAliases), ...stringArray(value?.userAliases), ...stringArray(value?.customEnvironment?.currentDeploymentAliases)];
  if (!aliases.includes(hostname)) throw new Error("trusted_alias_missing");
  const sha = typeof source.sha === "string" ? source.sha : typeof meta.githubCommitSha === "string" ? meta.githubCommitSha : null;
  const ref = typeof source.ref === "string" ? source.ref : typeof meta.githubCommitRef === "string" ? meta.githubCommitRef : null;
  const returnedHostname = typeof value?.url === "string" ? value.url : null;
  if (!SAFE_HOSTNAME.test(returnedHostname ?? "")) throw new Error("invalid_deployment_url");
  return {
    hostname,
    url: returnedHostname,
    id,
    state: typeof value?.readyState === "string" ? value.readyState : typeof value?.state === "string" ? value.state : null,
    created_at: value?.createdAt ?? value?.created ?? null,
    age_ms: boundedAge(value?.createdAt ?? value?.created, now),
    ref,
    sha: /^[0-9a-f]{40}$/i.test(sha ?? "") ? sha.toLowerCase() : null,
    git_dirty: source.dirty === true || source.dirty === "true" || meta.gitDirty === true || meta.gitDirty === "true",
  };
}

function environmentEvidence(value) {
  const source = Array.isArray(value) ? value : Array.isArray(value?.envs) ? value.envs : null;
  if (!source) throw invalidPlatformEvidence("invalid_environment_container");
  const normalized = source.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalidPlatformEvidence("invalid_environment_entry");
    if (typeof item.key !== "string" || !item.key) throw invalidPlatformEvidence("invalid_environment_key");
    if (!ENVIRONMENT_TYPES.has(item.type)) throw invalidPlatformEvidence("invalid_environment_type");
    const validTarget = typeof item.target === "string"
      ? ENVIRONMENT_TARGETS.has(item.target)
      : Array.isArray(item.target) && item.target.every((target) => typeof target === "string" && ENVIRONMENT_TARGETS.has(target));
    if (!validTarget) throw invalidPlatformEvidence("invalid_environment_target");
    return { name: item.key, targets: stringArray(item.target), type: item.type };
  });
  const present = new Set(normalized.filter((item) => item.targets.includes("production")).map((item) => item.name));
  return { state: "observed", target: "production", records: normalized.slice(0, 500), required_missing: REQUIRED_ENVIRONMENT.filter((name) => !present.has(name)) };
}

function runtimeErrors(value) {
  if (!Array.isArray(value)) throw invalidPlatformEvidence("invalid_runtime_log_container");
  const items = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalidPlatformEvidence("invalid_runtime_log_entry");
    if (!RUNTIME_LOG_LEVELS.has(item.level)) throw invalidPlatformEvidence("invalid_runtime_log_level");
    if (!Number.isInteger(item.responseStatusCode) || item.responseStatusCode < 100 || item.responseStatusCode > 599) throw invalidPlatformEvidence("invalid_runtime_log_status");
    return item;
  });
  return { state: "observed", recent_errors: items.filter((item) => item && typeof item === "object" && (String(item.level ?? "").toLowerCase() === "error" || Number(item.statusCode ?? item.responseStatusCode) >= 500)).slice(-20).map(() => ({})) };
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
  const response = await vercelGetResponse(fetchImpl, pathname, token, deadlineSignal);
  try { return await response.json(); }
  catch { throw invalidPlatformEvidence("invalid_vercel_json"); }
}

function runtimeLogContainer(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") throw invalidPlatformEvidence("invalid_runtime_log_container");
  if (Object.hasOwn(value, "data")) {
    if (!Array.isArray(value.data)) throw invalidPlatformEvidence("invalid_runtime_log_container");
    return value.data;
  }
  if (Object.hasOwn(value, "level") || Object.hasOwn(value, "responseStatusCode")) return [value];
  throw invalidPlatformEvidence("invalid_runtime_log_container");
}

async function vercelGetRuntimeLogs(fetchImpl, pathname, token, deadlineSignal) {
  const response = await vercelGetResponse(fetchImpl, pathname, token, deadlineSignal);
  const text = await response.text();
  if (Buffer.byteLength(text) > 1_000_000) throw new Error("vercel_runtime_logs_too_large");
  let value;
  try { value = JSON.parse(text); }
  catch {
    if (!text.trim()) throw invalidPlatformEvidence("invalid_runtime_log_container");
    return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return runtimeLogContainer(JSON.parse(line.startsWith("data:") ? line.slice(5).trim() : line)); }
      catch (error) {
        if (isInvalidPlatformEvidence(error)) throw error;
        throw invalidPlatformEvidence("invalid_runtime_log_json");
      }
    });
  }
  return runtimeLogContainer(value);
}

async function observePlatform({ environment, env, fetchImpl, now, deadlineSignal }) {
  const token = env?.VERCEL_READ_TOKEN;
  if (typeof token !== "string" || token.length < MIN_SECRET_LENGTH) return unavailablePlatform("read-only Vercel access is not configured");
  const hostname = new URL(fixedOrigin(environment)).hostname;
  const projectId = environment === "development" ? DEVELOPMENT_PROJECT_ID : PRODUCTION_PROJECT_ID;
  const inspectPath = `/v13/deployments/${hostname}?withGitRepoInfo=true&teamId=${VERCEL_TEAM_ID}`;
  const environmentPath = `/v10/projects/${projectId}/env?teamId=${VERCEL_TEAM_ID}`;
  const [deploymentResult, environmentResult] = await Promise.allSettled([
    vercelGetJson(fetchImpl, inspectPath, token, deadlineSignal),
    vercelGetJson(fetchImpl, environmentPath, token, deadlineSignal),
  ]);
  const blockers = [];
  if (deploymentResult.status !== "fulfilled") blockers.push(platformReadBlocker(deploymentResult.reason, "deployment metadata endpoint is unavailable", "deployment metadata evidence is invalid"));
  if (environmentResult.status !== "fulfilled") blockers.push(platformReadBlocker(environmentResult.reason, "environment metadata endpoint is unavailable", "environment metadata evidence is invalid"));
  let deployment = null;
  if (deploymentResult.status === "fulfilled") {
    try { deployment = deploymentEvidence(deploymentResult.value, hostname, projectId, now); }
    catch { blockers.push({ code: "platform_evidence_invalid", detail: "deployment identity evidence is invalid" }); }
  }
  let environmentEvidenceResult = unknownEnvironment();
  if (environmentResult.status === "fulfilled") {
    try { environmentEvidenceResult = environmentEvidence(environmentResult.value); }
    catch { blockers.push({ code: "platform_evidence_invalid", detail: "environment metadata evidence is invalid" }); }
  }
  let logs = unknownLogs();
  if (deployment?.id) {
    try {
      logs = runtimeErrors(await vercelGetRuntimeLogs(fetchImpl, `/v1/projects/${projectId}/deployments/${deployment.id}/runtime-logs?teamId=${VERCEL_TEAM_ID}`, token, deadlineSignal));
    } catch (error) { blockers.push(platformReadBlocker(error, "runtime logs endpoint is unavailable", "runtime log evidence is invalid")); }
  }
  const inspectedCrons = deployment && Array.isArray(deploymentResult.value?.crons) ? deploymentResult.value.crons : null;
  return {
    state: blockers.length ? "access_blocked" : "ok",
    expected_sha: null,
    deployment,
    environment: environmentEvidenceResult,
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
    if (deadlineSignal?.aborted) return monitorFailure(environment, now, "monitor_deadline_exceeded", knownSecrets);
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
  if (!requestUrl || request.method !== "GET" || !trustedCronOrigin(requestUrl, env) || requestUrl.pathname !== CRON_PATH || requestUrl.search || requestUrl.hash) return guardFailure(404, "route_guard_failed", now, env);

  const knownSecrets = [env.CRON_SECRET, env.DEVELOPMENT_OPS_READ_TOKEN, env.PRODUCTION_OPS_READ_TOKEN, env.VERCEL_READ_TOKEN].filter(Boolean);
  if (!credentialsSeparated([env.CRON_SECRET, env.DEVELOPMENT_OPS_READ_TOKEN, env.PRODUCTION_OPS_READ_TOKEN, env.VERCEL_READ_TOKEN])) return guardFailure(503, "credential_separation_failed", now, env);

  const deadlineMs = Number.isSafeInteger(requestedDeadline) && requestedDeadline > 0 && requestedDeadline <= DEADLINE_MS ? requestedDeadline : DEADLINE_MS;
  const deadlineController = new AbortController();
  let deadlineTimer;
  const environments = ["development", "production"];
  const collection = environments.map((environment) => collectEnvironment({
    environment,
    token: environment === "development" ? env.DEVELOPMENT_OPS_READ_TOKEN : env.PRODUCTION_OPS_READ_TOKEN,
    env,
    fetchImpl,
    collectStatus,
    now,
    knownSecrets,
    deadlineSignal: deadlineController.signal,
  }));
  const completeCollection = Promise.all(collection);
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => { deadlineController.abort(); resolve(null); }, deadlineMs);
    deadlineTimer.unref?.();
  });
  const events = await Promise.race([completeCollection, deadline]);
  clearTimeout(deadlineTimer);
  if (!events) {
    deadlineController.abort();
    const fallback = (environment) => new Promise((resolve) => setTimeout(() => resolve(monitorFailure(environment, now, "monitor_deadline_exceeded", knownSecrets)), 0));
    const boundedEvents = await Promise.all(
      collection.map((pending, index) => Promise.race([pending, fallback(environments[index])])),
    );
    return result(502, boundedEvents);
  }
  return result(events.some(({ kind }) => kind === "monitor_self_failure") ? 502 : 200, events);
}
