import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { redactOpsValue } from "../../lib/ops-redaction.mjs";

export const STATUS_SCHEMA_VERSION = "agent_ops_status.v1";
export const EXIT_CODES = Object.freeze({ healthy: 0, degraded: 1, failed: 2, access_blocked: 3, usage_error: 64 });

const OPS_PATHS = new Set(["/api/health", "/api/ops/v1", "/api/ops/v1/summary", "/api/ops/v1/inventory", "/api/ops/v1/read"]);
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const MAX_HTTP_RESPONSE_BYTES = 1_000_000;
const MAX_INVENTORY_PAGES = 10;
const MAX_INVENTORY_KINDS = 20;
const MAX_RUN_READS = 20;
const REQUIRED_ENVIRONMENT = ["OPS_READ_TOKEN", "OPS_READ_CURSOR_SECRET", "AI_GATEWAY_API_KEY", "RUNNER_CALLBACK_SECRET", "BLOB_READ_WRITE_TOKEN"];
const SAFE_TARGET = /^(?:[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}|dpl_[A-Za-z0-9_]+)$/;
const SAFE_REF = /^(?:main|dev)$/;

const ENVIRONMENTS = Object.freeze({
  production: { base_url: "https://harness-arena-psi.vercel.app", expected_ref: "main", vercel_environment: "production", collect_platform: true },
  development: { base_url: "http://127.0.0.1:3000", expected_ref: "dev", vercel_environment: "preview", collect_platform: true },
  local: { base_url: "http://127.0.0.1:3000", expected_ref: null, vercel_environment: "development", collect_platform: false },
});

export function redactSensitive(value, knownSecrets = []) {
  return redactOpsValue(value, knownSecrets);
}

function safeBaseUrl(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !["", "/"].includes(url.pathname) || url.search || url.hash) throw new Error("invalid_base_url");
  url.pathname = "/";
  return url;
}

function safeOpsPath(path) {
  const url = new URL(path, "https://ops.invalid");
  if (!OPS_PATHS.has(url.pathname)) throw new Error("unsafe_ops_path");
  return url;
}

function resolveEnvironment(environment, env) {
  const preset = ENVIRONMENTS[environment];
  if (!preset) throw new Error("invalid_environment");
  const key = `HARNESS_ARENA_${environment.toUpperCase()}_URL`;
  const base_url = safeBaseUrl(env[key] ?? preset.base_url).toString().replace(/\/$/, "");
  const hostname = new URL(base_url).hostname;
  const vercel_target = preset.collect_platform && hostname !== "127.0.0.1" && hostname !== "localhost" ? hostname : null;
  return { environment, ...preset, base_url, vercel_target };
}

export function parseCliArgs(argv, env = process.env) {
  let environment, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") json = true;
    else if (argument === "--env") environment = argv[++index];
    else if (argument === "--token" || argument?.startsWith("--token=")) throw new Error("token_argument_not_allowed");
    else throw new Error("usage: pnpm ops:status --env <production|development|local> [--json]");
  }
  if (!environment) throw new Error("environment_required");
  return { ...resolveEnvironment(environment, env), json, token: env.OPS_READ_TOKEN };
}

function commandError(code, message = code) { const error = new Error(message); error.code = code; return error; }

export async function spawnCommand(binary, args, { timeoutMs = DEFAULT_TIMEOUT_MS, killGraceMs = 250, maxBufferBytes = MAX_COMMAND_OUTPUT_BYTES, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(binary, args, { stdio: ["ignore", "pipe", "pipe"], shell: false }); }
    catch (error) { reject(error); return; }
    let stdout = "", stderr = "", bytes = 0, pendingError = null, settled = false, killTimer, forceTimer;
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timeoutTimer); clearTimeout(killTimer); clearTimeout(forceTimer); callback(value); };
    const terminate = (error) => {
      if (pendingError || settled) return;
      pendingError = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { child.kill("SIGKILL"); forceTimer = setTimeout(() => finish(reject, pendingError), killGraceMs); }, killGraceMs);
    };
    const consume = (streamName) => (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBufferBytes) { terminate(commandError("command_output_limit")); return; }
      if (streamName === "stdout") stdout += chunk; else stderr += chunk;
    };
    child.stdout?.on("data", consume("stdout"));
    child.stderr?.on("data", consume("stderr"));
    child.on("error", (error) => finish(reject, error));
    child.on("close", (exitCode, signal) => pendingError ? finish(reject, pendingError) : finish(resolve, { stdout, stderr, exitCode: exitCode ?? 1, signal: signal ?? null }));
    const timeoutTimer = setTimeout(() => terminate(commandError("command_timeout")), timeoutMs);
  });
}

function validVercelArgs(args) {
  if (!Array.isArray(args)) return false;
  if (args.length === 4 && args[0] === "ls" && args[1] === "--json" && args[2] === "--environment") return ["production", "preview", "development"].includes(args[3]);
  if (args.length === 3 && args[0] === "inspect" && args[2] === "--json") return SAFE_TARGET.test(args[1]) && !args[1].startsWith("-");
  if (args.length === 4 && args[0] === "env" && args[1] === "ls" && args[3] === "--json") return ["production", "preview", "development"].includes(args[2]);
  if (args.length === 5 && args[0] === "logs" && args[2] === "--json" && args[3] === "--since" && args[4] === "1h") return SAFE_TARGET.test(args[1]) && !args[1].startsWith("-");
  return false;
}

export function createVercelCommandAdapter(run = spawnCommand) {
  const execute = async (args) => {
    if (!validVercelArgs(args)) throw new Error("unsafe_vercel_command");
    return run("vercel", args, { timeoutMs: DEFAULT_TIMEOUT_MS, maxBufferBytes: MAX_COMMAND_OUTPUT_BYTES });
  };
  return {
    run: execute,
    list: (environment) => execute(["ls", "--json", "--environment", environment]),
    inspect: (target) => execute(["inspect", target, "--json"]),
    environment: (environment) => execute(["env", "ls", environment, "--json"]),
    logs: (target) => execute(["logs", target, "--json", "--since", "1h"]),
  };
}

export function createGitHubCommandAdapter(run = spawnCommand) {
  return { async expectedSha(ref) {
    if (!SAFE_REF.test(ref)) throw new Error("unsafe_github_ref");
    return run("gh", ["api", `repos/dennisonbertram/harness-arena/commits/${ref}`, "--jq", ".sha"], { timeoutMs: DEFAULT_TIMEOUT_MS, maxBufferBytes: 128_000 });
  } };
}

function parseJson(text, code) { try { return JSON.parse(text); } catch { throw new Error(code); } }
function ageMs(createdAt, now) { const created = Date.parse(createdAt ?? ""), current = Date.parse(now); return Number.isFinite(created) && Number.isFinite(current) ? Math.max(0, current - created) : null; }
function booleanDirty(value) { return value === true || value === "1" || value === 1 || value === "true"; }
function deploymentModel(value, now) {
  const meta = value.meta ?? {}, source = value.gitSource ?? {};
  const created_at = value.createdAt ?? value.created_at ?? value.created;
  return {
    hostname: value.url ?? value.hostname ?? value.alias?.[0] ?? null,
    id: value.uid ?? value.id ?? null,
    state: value.readyState ?? value.state ?? value.status ?? null,
    created_at: created_at ?? null,
    age_ms: ageMs(created_at, now),
    ref: source.ref ?? meta.githubCommitRef ?? value.ref ?? null,
    sha: source.sha ?? meta.githubCommitSha ?? value.sha ?? null,
    git_dirty: booleanDirty(source.dirty ?? meta.gitDirty ?? value.gitDirty),
  };
}

export function parseVercelList(text, { now = new Date().toISOString() } = {}) {
  const value = parseJson(text, "invalid_vercel_list_json");
  const deployments = Array.isArray(value) ? value : Array.isArray(value.deployments) ? value.deployments : [];
  return { deployments: deployments.slice(0, 50).map((item) => deploymentModel(item, now)) };
}

export function parseVercelInspect(text, { now = new Date().toISOString() } = {}) {
  const value = parseJson(text, "invalid_vercel_inspect_json");
  const crons = Array.isArray(value.crons) ? value.crons : Array.isArray(value.routes?.crons) ? value.routes.crons : null;
  return { deployment: deploymentModel(value, now), cron: { state: crons === null ? "unknown" : crons.length ? "configured" : "missing", count: crons?.length ?? null } };
}

export function parseVercelEnvironment(text, target, { now = new Date().toISOString() } = {}) {
  const value = parseJson(text, "invalid_vercel_env_json");
  const source = Array.isArray(value) ? value : Array.isArray(value.envs) ? value.envs : Array.isArray(value.environments) ? value.environments : [];
  const records = source.slice(0, 500).map((item) => {
    const created_at = item.createdAt ?? item.created_at ?? null;
    return { name: item.key ?? item.name ?? "unknown", targets: Array.isArray(item.target) ? item.target : item.target ? [item.target] : [], type: item.type ?? "unknown", created_at, age_ms: ageMs(created_at, now) };
  });
  const present = new Set(records.filter((item) => item.targets.length === 0 || item.targets.includes(target)).map((item) => item.name));
  return { target, records, required: [...REQUIRED_ENVIRONMENT], required_missing: REQUIRED_ENVIRONMENT.filter((name) => !present.has(name)) };
}

export function parseVercelLogs(text) {
  const recent_errors = [];
  for (const line of text.slice(0, MAX_COMMAND_OUTPUT_BYTES).split(/\r?\n/).filter(Boolean).slice(-200)) {
    let item; try { item = JSON.parse(line); } catch { continue; }
    const status = Number(item.statusCode ?? item.status_code ?? item.status);
    if (String(item.level ?? "").toLowerCase() !== "error" && (!Number.isFinite(status) || status < 500)) continue;
    recent_errors.push(redactSensitive({ timestamp: item.timestamp ?? item.createdAt ?? null, level: item.level ?? "error", status_code: Number.isFinite(status) ? status : null, message: String(item.message ?? item.msg ?? item.error ?? "runtime error").slice(0, 500) }));
  }
  return { recent_errors: recent_errors.slice(-20), scanned_records: Math.min(200, text.split(/\r?\n/).filter(Boolean).length) };
}

export function parseGitHubExpectedSha(text) {
  const value = text.trim();
  if (!/^[0-9a-f]{6,64}$/i.test(value)) throw new Error("invalid_expected_sha");
  return value.toLowerCase();
}

function provenance(binary, args, result) {
  return { binary, argv: [...args], exit_code: result?.exitCode ?? null, state: result?.exitCode === 0 ? "ok" : "failed" };
}

export async function collectPlatformEvidence({ environment, commandRunner = spawnCommand, env = process.env, now = new Date().toISOString(), target, expectedRef } = {}) {
  const config = resolveEnvironment(environment, env);
  if (!config.collect_platform) return { requested_environment: environment, state: "not_applicable", expected_sha: null, deployment: null, environment: { target: null, records: [], required_missing: [] }, logs: { recent_errors: [] }, cron: { state: "not_applicable" }, blockers: [], command_provenance: [] };
  const resolvedTarget = target ?? config.vercel_target;
  const resolvedRef = expectedRef ?? config.expected_ref;
  if (!resolvedTarget) return { requested_environment: environment, state: "access_blocked", expected_sha: null, deployment: null, environment: { target: config.vercel_environment, records: [], required_missing: [] }, logs: { recent_errors: [] }, cron: { state: "unknown" }, blockers: [{ code: "platform_target_missing", detail: `Set HARNESS_ARENA_${environment.toUpperCase()}_URL to a deployed hostname` }], command_provenance: [] };
  const vercel = createVercelCommandAdapter(commandRunner), github = createGitHubCommandAdapter(commandRunner);
  const operations = [
    { name: "vercel_list", binary: "vercel", args: ["ls", "--json", "--environment", config.vercel_environment], promise: vercel.list(config.vercel_environment), parse: (output) => parseVercelList(output, { now }) },
    { name: "vercel_inspect", binary: "vercel", args: ["inspect", resolvedTarget, "--json"], promise: vercel.inspect(resolvedTarget), parse: (output) => parseVercelInspect(output, { now }) },
    { name: "vercel_env", binary: "vercel", args: ["env", "ls", config.vercel_environment, "--json"], promise: vercel.environment(config.vercel_environment), parse: (output) => parseVercelEnvironment(output, config.vercel_environment, { now }) },
    { name: "vercel_logs", binary: "vercel", args: ["logs", resolvedTarget, "--json", "--since", "1h"], promise: vercel.logs(resolvedTarget), parse: parseVercelLogs },
    { name: "github_expected_sha", binary: "gh", args: ["api", `repos/dennisonbertram/harness-arena/commits/${resolvedRef}`, "--jq", ".sha"], promise: github.expectedSha(resolvedRef), parse: parseGitHubExpectedSha },
  ];
  const settled = await Promise.allSettled(operations.map((operation) => operation.promise));
  const parsed = {}, blockers = [], command_provenance = [];
  settled.forEach((outcome, index) => {
    const operation = operations[index];
    if (outcome.status === "rejected") {
      blockers.push({ code: "platform_command_access", detail: redactSensitive(`${operation.name}: ${outcome.reason instanceof Error ? outcome.reason.message : "command failed"}`) });
      command_provenance.push({ binary: operation.binary, argv: operation.args, exit_code: null, state: "unavailable" });
      return;
    }
    command_provenance.push(provenance(operation.binary, operation.args, outcome.value));
    if (outcome.value.exitCode !== 0) { blockers.push({ code: "platform_command_failed", detail: `${operation.name} exited ${outcome.value.exitCode}` }); return; }
    try { parsed[operation.name] = operation.parse(outcome.value.stdout); }
    catch (error) { blockers.push({ code: "platform_evidence_invalid", detail: `${operation.name}: ${error instanceof Error ? error.message : "parse failed"}` }); }
  });
  const listDeployment = parsed.vercel_list?.deployments?.find((item) => item.hostname === resolvedTarget) ?? parsed.vercel_list?.deployments?.[0] ?? null;
  const inspectDeployment = parsed.vercel_inspect?.deployment ?? null;
  const contradictions = [];
  if (listDeployment && inspectDeployment) {
    for (const field of ["id", "state", "ref", "sha", "git_dirty"]) {
      if (listDeployment[field] !== null && inspectDeployment[field] !== null && listDeployment[field] !== inspectDeployment[field]) contradictions.push({ field, list: listDeployment[field], inspect: inspectDeployment[field] });
    }
  }
  const deployment = inspectDeployment ? { ...listDeployment, ...inspectDeployment } : listDeployment;
  return redactSensitive({ requested_environment: environment, state: blockers.length ? "access_blocked" : "ok", expected_sha: parsed.github_expected_sha ?? null, deployment, contradictions, environment: parsed.vercel_env ?? { target: config.vercel_environment, records: [], required_missing: [...REQUIRED_ENVIRONMENT] }, logs: parsed.vercel_logs ?? { recent_errors: [] }, cron: parsed.vercel_inspect?.cron ?? { state: "unknown" }, blockers, command_provenance });
}

function requestKind(result) {
  if (result.status === 401 || result.status === 403) return "access";
  if (result.error === "redirect_rejected") return "redirect";
  if (result.error === "response_too_large") return "response_too_large";
  if (result.error === "invalid_content_length") return "invalid_content_length";
  if (result.error === "response_stream_unavailable") return "response_stream_unavailable";
  if (result.error === "invalid_json") return "invalid_json";
  if (result.error === "request_timeout") return "timeout";
  if (result.error === "request_failed" || result.error === "invalid_response") return "transport";
  if (result.status === 429 || result.status >= 500) return "transient";
  return "http";
}

const INTERNAL_FAILURES = new WeakMap();
const INTERNAL_FAILURE_CODES = new Set(["redirect_rejected", "response_too_large", "invalid_content_length", "response_stream_unavailable", "invalid_response", "invalid_json", "request_timeout", "request_failed"]);
function responseError(code) {
  const error = new Error(code);
  INTERNAL_FAILURES.set(error, code);
  return error;
}
function failureCode(error, fallback) {
  try {
    const code = error && (typeof error === "object" || typeof error === "function") ? INTERNAL_FAILURES.get(error) : undefined;
    return INTERNAL_FAILURE_CODES.has(code) ? code : fallback;
  } catch { return fallback; }
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(responseError("request_timeout"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => finish(reject, responseError("request_timeout"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function invokeCleanup(callback) {
  if (typeof callback !== "function") return;
  try { Promise.resolve(callback()).catch(() => {}); } catch {}
}

function disposeRawResponse(response, controller) {
  controller.abort();
  try {
    const body = response && (typeof response === "object" || typeof response === "function") ? response.body : undefined;
    if (!body || (typeof body !== "object" && typeof body !== "function")) return;
    const cancel = body.cancel;
    invokeCleanup(typeof cancel === "function" ? cancel.bind(body) : undefined);
  } catch {}
}

function normalizeResponse(response, controller) {
  try {
    if (!response || (typeof response !== "object" && typeof response !== "function")) throw responseError("invalid_response");
    const status = response.status;
    if (!Number.isInteger(status) || status < 100 || status > 599) throw responseError("invalid_response");
    const headers = response.headers;
    if (!headers || (typeof headers !== "object" && typeof headers !== "function")) throw responseError("invalid_response");
    const getHeader = headers.get;
    if (typeof getHeader !== "function") throw responseError("invalid_response");
    const contentLength = getHeader.call(headers, "content-length");
    if (contentLength !== null && typeof contentLength !== "string") throw responseError("invalid_response");
    const bodyUsed = response.bodyUsed;
    if (bodyUsed !== undefined && typeof bodyUsed !== "boolean") throw responseError("invalid_response");
    if (bodyUsed === true) throw responseError("invalid_response");
    const body = response.body;
    if (body !== null && body !== undefined && typeof body !== "object" && typeof body !== "function") throw responseError("invalid_response");
    let bodyCancel, getReader;
    if (body) {
      const locked = body.locked;
      if (locked !== undefined && typeof locked !== "boolean") throw responseError("invalid_response");
      if (locked === true) throw responseError("invalid_response");
      const cancel = body.cancel;
      if (cancel !== undefined && typeof cancel !== "function") throw responseError("invalid_response");
      bodyCancel = typeof cancel === "function" ? cancel.bind(body) : undefined;
      const acquire = body.getReader;
      if (acquire !== undefined && typeof acquire !== "function") throw responseError("invalid_response");
      getReader = typeof acquire === "function" ? acquire.bind(body) : undefined;
    }
    return { status, ok: status >= 200 && status < 300, contentLength, body, bodyCancel, getReader };
  } catch (error) {
    disposeRawResponse(response, controller);
    throw responseError(failureCode(error, "invalid_response"));
  }
}

function acquireReader(response, reader) {
  if (!response.body || !response.getReader) throw responseError("response_stream_unavailable");
  let raw;
  try { raw = response.getReader(); }
  catch { throw responseError("invalid_response"); }
  if (!raw || (typeof raw !== "object" && typeof raw !== "function")) throw responseError("invalid_response");
  let valid = true;
  for (const name of ["cancel", "releaseLock", "read"]) {
    try {
      const method = raw[name];
      if (typeof method === "function") reader[name] = method.bind(raw);
      else valid = false;
    } catch { valid = false; }
  }
  if (!valid) throw responseError("invalid_response");
  return reader;
}

function cancelResponse(response, controller, reader) {
  controller.abort();
  invokeCleanup(reader?.cancel ?? response?.bodyCancel);
}

const ARRAY_BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength").get;
const TYPED_ARRAY_BYTE_OFFSET = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset").get;
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer").get;
const TYPED_ARRAY_TAG = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag).get;

function boundedChunk(value, remaining) {
  try {
    const byteLength = ARRAY_BUFFER_BYTE_LENGTH.call(value);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw responseError("invalid_response");
    if (byteLength > remaining) throw responseError("response_too_large");
    return Buffer.from(value);
  } catch (error) {
    const code = failureCode(error, undefined);
    if (code) throw responseError(code);
  }
  try {
    const tag = TYPED_ARRAY_TAG.call(value);
    if (tag !== "Uint8Array" && tag !== "Uint8ClampedArray") throw responseError("invalid_response");
    const byteLength = TYPED_ARRAY_BYTE_LENGTH.call(value);
    const byteOffset = TYPED_ARRAY_BYTE_OFFSET.call(value);
    const buffer = TYPED_ARRAY_BUFFER.call(value);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || !Number.isSafeInteger(byteOffset) || byteOffset < 0) throw responseError("invalid_response");
    if (byteLength > remaining) throw responseError("response_too_large");
    return Buffer.from(buffer, byteOffset, byteLength);
  } catch (error) {
    throw responseError(failureCode(error, "invalid_response"));
  }
}

async function readBoundedJson(response, controller, maxBytes) {
  const reader = {};
  try {
    const rawLength = response.contentLength;
    if (rawLength !== null) {
      const normalized = rawLength.trim();
      if (!/^(?:0|[1-9]\d*)$/.test(normalized) || !Number.isSafeInteger(Number(normalized))) throw responseError("invalid_content_length");
      if (Number(normalized) > maxBytes) throw responseError("response_too_large");
    }
    acquireReader(response, reader);
    const chunks = [];
    let bytes = 0;
    while (true) {
      const result = await withAbort(Promise.resolve().then(() => reader.read()), controller.signal);
      if (!result || (typeof result !== "object" && typeof result !== "function")) throw responseError("invalid_response");
      const done = result.done;
      if (typeof done !== "boolean") throw responseError("invalid_response");
      if (done) break;
      const value = result.value;
      let chunk;
      try { chunk = boundedChunk(value, maxBytes - bytes); } catch (error) { throw responseError(failureCode(error, "invalid_response")); }
      bytes += chunk.byteLength;
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")); }
    catch { throw responseError("invalid_json"); }
  } catch (error) {
    const code = controller.signal.aborted ? "request_timeout" : failureCode(error, "invalid_response");
    cancelResponse(response, controller, reader);
    throw responseError(code);
  } finally {
    invokeCleanup(reader?.releaseLock);
  }
}

export async function requestOpsJson({ baseUrl, path, token, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, maxResponseBytes = MAX_HTTP_RESPONSE_BYTES }) {
  const parsedPath = safeOpsPath(path), attemptsAllowed = Math.min(3, Math.max(1, retries + 1));
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error("invalid_response_limit");
  const url = new URL(parsedPath.pathname, baseUrl);
  for (const [key, value] of parsedPath.searchParams) url.searchParams.append(key, value);
  let last;
  for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let rawResponse, fetched = false;
      try {
        const fetchPromise = Promise.resolve().then(() => fetchImpl(url.toString(), { method: "GET", headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: "manual", signal: controller.signal }));
        fetchPromise.then((late) => { if (controller.signal.aborted) disposeRawResponse(late, controller); }, () => {});
        rawResponse = await withAbort(fetchPromise, controller.signal);
        fetched = true;
      } catch (error) {
        const code = failureCode(error, controller.signal.aborted ? "request_timeout" : "request_failed");
        last = { ok: false, status: 0, error: code, detail: redactSensitive(error instanceof Error ? error.message : "unknown", token ? [token] : []), attempts: attempt };
      }
      if (fetched) {
        let response;
        try { response = normalizeResponse(rawResponse, controller); }
        catch (error) { last = { ok: false, status: 0, error: failureCode(error, controller.signal.aborted ? "request_timeout" : "invalid_response"), attempts: attempt }; }
        if (response && response.status >= 300 && response.status < 400) {
          cancelResponse(response, controller);
          last = { ok: false, status: response.status, error: "redirect_rejected", attempts: attempt };
        } else if (response) {
          try {
            const body = await readBoundedJson(response, controller, maxResponseBytes);
            last = { ok: response.ok, status: response.status, body: redactSensitive(body, token ? [token] : []), attempts: attempt };
          } catch (error) {
            last = { ok: false, status: response.status, error: failureCode(error, controller.signal.aborted ? "request_timeout" : "invalid_response"), attempts: attempt };
          }
        }
      }
    } finally { clearTimeout(timer); }
    const kind = requestKind(last);
    const retryable = kind === "transient" || last.error === "request_failed" || last.error === "request_timeout";
    if (last.ok || !retryable || attempt === attemptsAllowed) return { ...last, kind };
  }
  return last;
}

async function inventoryKind({ kind, ...options }) {
  let cursor, records = 0, pages = 0, complete = true, error = null;
  const items = [];
  do {
    const query = new URLSearchParams({ kind, limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await requestOpsJson({ ...options, path: `/api/ops/v1/inventory?${query}` });
    if (!response.ok) {
      const remoteError = typeof response.body?.error === "string" ? response.body.error : typeof response.body?.error?.code === "string" ? response.body.error.code : undefined;
      complete = false; error = response.kind === "access" ? "access_blocked" : remoteError ?? response.error ?? `http_${response.status}`; break;
    }
    const body = response.body ?? {};
    if (body.schema_version !== "ops.v1" || body.kind !== kind || !Array.isArray(body.items)) { complete = false; error = "malformed_contract"; break; }
    const hasCursorField = Object.hasOwn(body, "next_cursor");
    const cursorTypeValid = body.has_more === true ? body.next_cursor === null || typeof body.next_cursor === "string" : body.has_more === false ? body.next_cursor === null : false;
    if (typeof body.has_more !== "boolean" || !hasCursorField || !cursorTypeValid) { complete = false; error = "malformed_pagination"; break; }
    const pageItems = body.items;
    if (pageItems.length > 100) { complete = false; error = "page_item_limit"; break; }
    items.push(...pageItems); records += pageItems.length; pages += 1;
    if (body.partial === true) { complete = false; error = "partial_read"; break; }
    if (body.has_more === true && !body.next_cursor) { complete = false; error = "missing_cursor"; break; }
    if (body.has_more !== true && body.next_cursor) { complete = false; error = "contradictory_pagination"; break; }
    cursor = body.has_more ? body.next_cursor : null;
    if (cursor && pages >= MAX_INVENTORY_PAGES) { complete = false; error = "page_limit"; break; }
  } while (cursor);
  return { records, pages, complete, ...(error ? { error } : {}), items };
}

function runIdFromPath(pathname) { return /^runs\/([A-Za-z0-9._-]+)\.json$/.exec(pathname ?? "")?.[1] ?? null; }
function eventFromPath(pathname) { const match = /^events\/([A-Za-z0-9._-]+)\/(\d+)\.json$/.exec(pathname ?? ""); return match ? { run_id: match[1], seq: Number(match[2]) } : null; }

async function correlateRuns(inventory, options, validRunRecords) {
  const eventByRun = new Map();
  for (const record of inventory.events?.items ?? []) {
    const event = eventFromPath(record.pathname); if (!event) continue;
    const previous = eventByRun.get(event.run_id); if (!previous || event.seq > previous.seq) eventByRun.set(event.run_id, event);
  }
  const runs = [];
  const selectedRuns = [...validRunRecords].sort((left, right) => String(right.uploaded_at).localeCompare(String(left.uploaded_at))).slice(0, MAX_RUN_READS);
  for (const record of selectedRuns) {
    const run_id = runIdFromPath(record.pathname); if (!run_id) continue;
    const runResponse = await requestOpsJson({ ...options, path: `/api/ops/v1/read?kind=runs&id=${encodeURIComponent(run_id)}` });
    if (!runResponse.ok) { runs.push({ run_id, evidence: "unavailable", error: runResponse.kind }); continue; }
    const item = runResponse.body?.item ?? {}, tasks = Array.isArray(item.task_results) ? item.task_results : null, latest = eventByRun.get(run_id);
    let latest_event;
    if (latest) {
      const eventResponse = await requestOpsJson({ ...options, path: `/api/ops/v1/read?kind=events&run_id=${encodeURIComponent(run_id)}&seq=${latest.seq}` });
      const eventItem = eventResponse.ok ? eventResponse.body?.item ?? {} : {};
      latest_event = { seq: latest.seq, ...(eventResponse.ok ? { type: eventItem.type ?? null, action: eventItem.action ?? null, at: eventItem.created_at ?? eventItem.timestamp ?? null } : { evidence: "unavailable" }) };
    }
    const correlated = {
      run_id,
      state: item.status ?? "unknown",
      ...(item.sandbox_id ? { sandbox_id: item.sandbox_id } : {}),
      ...(item.callback_status ? { callback: item.callback_status } : item.callback_delivered !== undefined ? { callback: item.callback_delivered ? "delivered" : "pending" } : {}),
      ...(Number.isFinite(item.total_cost_usd) ? { cost_usd: item.total_cost_usd } : {}),
      ...(tasks ? { tasks: { total: tasks.length, passed: tasks.filter((task) => task?.passed === true).length } } : {}),
      ...(item.provider ? { provider: item.provider } : {}),
      ...(item.model ? { model: item.model } : {}),
      ...(latest_event ? { latest_event } : {}),
    };
    const available = new Set(Object.keys(correlated));
    const missing = [["sandbox_id", "sandbox"], ["callback", "callback"], ["cost_usd", "cost"], ["tasks", "tasks"], ["provider", "provider"], ["latest_event", "latest_event"]].filter(([key]) => !available.has(key)).map(([, label]) => label);
    runs.push({ ...correlated, ...(missing.length ? { unavailable: missing } : {}) });
  }
  return runs;
}

function issue(code, severity, detail) { return { code, severity, detail: redactSensitive(detail) }; }
function addRequestIssue(result, scope, findings, blockers) {
  if (result.kind === "access") blockers.push(issue(`${scope}_access`, "access", `HTTP ${result.status}`));
  else findings.push(issue(`${scope}_${result.kind}`, "failed", result.error ?? `HTTP ${result.status}`));
}

function verdictFor(findings, blockers) {
  if (blockers.length) return { verdict: "access_blocked", exit_code: EXIT_CODES.access_blocked };
  if (findings.some((item) => item.severity === "failed")) return { verdict: "failed", exit_code: EXIT_CODES.failed };
  if (findings.length) return { verdict: "degraded", exit_code: EXIT_CODES.degraded };
  return { verdict: "healthy", exit_code: EXIT_CODES.healthy };
}

export async function collectAgentOpsStatus({ baseUrl, token, fetchImpl = fetch, now = new Date().toISOString(), timeoutMs = DEFAULT_TIMEOUT_MS, platform = { state: "unknown", blockers: [] }, environment = "local" } = {}) {
  const base = safeBaseUrl(baseUrl), requestOptions = { baseUrl: base, token, fetchImpl, timeoutMs, retries: 1 };
  const findings = [], blockers = [];
  for (const blocker of platform.blockers ?? []) blockers.push(issue(blocker.code ?? "platform_access", "access", blocker.detail ?? "platform evidence unavailable"));
  const health = await requestOpsJson({ ...requestOptions, path: "/api/health" });
  if (!health.ok) {
    addRequestIssue(health, "health", findings, blockers);
    const status = verdictFor(findings, blockers);
    return redactSensitive({ schema_version: STATUS_SCHEMA_VERSION, checked_at: now, environment, ...status, health: { http_status: health.status, evidence: health.kind }, platform, ops: null, freshness: { state: "unknown" }, findings, blockers }, token ? [token] : []);
  }
  if (health.body?.ok !== true) findings.push(issue("health_reported_false", "failed", "health endpoint returned ok=false"));
  if (health.body?.storage === "down") findings.push(issue("storage_down", "failed", "health storage is down"));
  else if (health.body?.storage !== "up") findings.push(issue(`storage_${health.body?.storage ?? "unknown"}`, "degraded", "health storage is not up"));
  if (health.body?.gateway_key_present !== true) findings.push(issue("gateway_capability_missing", "failed", "AI Gateway capability is absent or unknown"));
  if (health.body?.runner_secret_present !== true) findings.push(issue("callback_capability_missing", "failed", "runner callback capability is absent or unknown"));

  const root = await requestOpsJson({ ...requestOptions, path: "/api/ops/v1" });
  if (!root.ok) {
    addRequestIssue(root, "ops", findings, blockers);
    const status = verdictFor(findings, blockers);
    return redactSensitive({ schema_version: STATUS_SCHEMA_VERSION, checked_at: now, environment, ...status, health: health.body, platform, ops: null, freshness: { state: "unknown" }, findings, blockers }, token ? [token] : []);
  }
  if (root.body?.schema_version !== "ops.v1") findings.push(issue("ops_schema_drift", "failed", `expected ops.v1, received ${root.body?.schema_version ?? "missing"}`));
  const rootKinds = root.body?.kinds;
  const rawKinds = Array.isArray(rootKinds) ? rootKinds.map((entry) => typeof entry === "string" ? entry : entry?.kind) : [];
  const validKindContract = Array.isArray(rootKinds) && rawKinds.every((kind) => typeof kind === "string" && /^[a-z_]+$/.test(kind)) && new Set(rawKinds).size === rawKinds.length;
  if (!validKindContract) findings.push(issue("ops_root_contract", "failed", "ops root kinds must be an array of entries with unique valid kind strings"));
  const advertisedKinds = validKindContract ? rawKinds : [];
  const kinds = advertisedKinds.slice(0, MAX_INVENTORY_KINDS);
  const inventoryScope = { advertised: advertisedKinds.length, selected: kinds.length, truncated: advertisedKinds.length > kinds.length };
  if (inventoryScope.truncated) findings.push(issue("inventory_kind_limit", "degraded", `inventory limited to ${kinds.length} of ${advertisedKinds.length} advertised kinds`));
  if (!kinds.length) findings.push(issue("ops_inventory_unavailable", "failed", "ops API advertised no readable kinds"));

  const summary = await requestOpsJson({ ...requestOptions, path: "/api/ops/v1/summary" });
  if (!summary.ok) addRequestIssue(summary, "summary", findings, blockers);
  const inventory = {};
  for (const kind of kinds) {
    const snapshot = await inventoryKind({ ...requestOptions, kind });
    inventory[kind] = snapshot;
    if (!snapshot.complete) {
      if (snapshot.error === "access_blocked") blockers.push(issue(`inventory_${kind}_access`, "access", `${kind} inventory access blocked`));
      else findings.push(issue(`inventory_${kind}_partial`, "degraded", `${kind} inventory incomplete: ${snapshot.error}`));
    }
  }
  const runRecords = inventory.runs?.items ?? [];
  const validRunRecords = runRecords.filter((record) => runIdFromPath(record?.pathname) && Number.isFinite(Date.parse(record?.uploaded_at ?? "")));
  const invalidRunRecords = runRecords.length - validRunRecords.length;
  if (invalidRunRecords) findings.push(issue("run_inventory_record_invalid", "failed", `${invalidRunRecords} malformed run inventory records`));
  const runs = await correlateRuns(inventory, requestOptions, validRunRecords);
  const availableRuns = runRecords.length;
  const runCorrelationScope = { available: availableRuns, valid: validRunRecords.length, selected: Math.min(validRunRecords.length, MAX_RUN_READS), invalid: invalidRunRecords, truncated: validRunRecords.length > MAX_RUN_READS };
  if (runCorrelationScope.truncated) findings.push(issue("run_correlation_limit", "degraded", `run correlation limited to ${runCorrelationScope.selected} of ${runCorrelationScope.valid} valid inventoried runs`));
  if (runs.some((run) => run.evidence === "unavailable" || (run.unavailable ?? []).length)) findings.push(issue("run_correlation_partial", "degraded", "one or more run correlations have unavailable fields"));
  const publicInventory = Object.fromEntries(Object.entries(inventory).map(([kind, snapshot]) => [kind, { records: snapshot.records, pages: snapshot.pages, complete: snapshot.complete, ...(snapshot.error ? { error: snapshot.error } : {}) }]));
  const summaryBody = summary.ok ? summary.body : {};
  if (summary.ok && summaryBody.scan?.complete !== true) findings.push(issue("summary_incomplete", "degraded", "ops summary scan is incomplete"));
  if ((summaryBody.run_states?.stale ?? 0) > 0) findings.push(issue("stale_runs", "failed", `${summaryBody.run_states.stale} stale runs`));
  const integrity = summaryBody.integrity ?? {};
  if ((integrity.unreadable ?? 0) > 0 || (integrity.corrupt ?? 0) > 0 || (integrity.event_holes ?? 0) > 0) findings.push(issue("ops_integrity", "failed", "ops summary reports unreadable, corrupt, or missing records"));
  const latestRun = summaryBody.latest?.runs, latestTime = Date.parse(latestRun ?? ""), checkedTime = Date.parse(now);
  const freshness = Number.isFinite(latestTime) && Number.isFinite(checkedTime) ? { state: checkedTime - latestTime > 60 * 60 * 1000 ? "stale" : "fresh", age_ms: Math.max(0, checkedTime - latestTime), latest_at: latestRun } : { state: "unknown" };
  if (freshness.state === "unknown") findings.push(issue("freshness_unknown", "degraded", "latest run timestamp is unavailable"));
  else if (freshness.state === "stale") findings.push(issue("freshness_stale", "failed", `latest run is ${freshness.age_ms}ms old`));

  const deployment = platform.deployment;
  if (ENVIRONMENTS[environment]?.collect_platform && (deployment?.state !== "READY" || !deployment?.id || !SAFE_TARGET.test(deployment.id) || !deployment?.hostname || !SAFE_TARGET.test(deployment.hostname))) findings.push(issue("deployment_not_ready", "failed", "serving deployment must have a valid identity and READY state"));
  if (ENVIRONMENTS[environment]?.collect_platform && (!deployment?.sha || !deployment?.ref)) findings.push(issue("deployment_lineage_missing", "failed", "serving deployment must report a nonempty SHA and ref"));
  if (deployment?.sha && health.body?.sha && deployment.sha !== health.body.sha) findings.push(issue("deployment_sha_drift", "failed", "serving deployment SHA differs from health SHA"));
  if (platform.expected_sha && deployment?.sha && platform.expected_sha !== deployment.sha) findings.push(issue("expected_sha_drift", "failed", "serving deployment SHA differs from expected GitHub SHA"));
  const expectedRef = ENVIRONMENTS[environment]?.expected_ref;
  if (expectedRef && deployment?.ref && deployment.ref !== expectedRef) findings.push(issue("deployment_ref_drift", "failed", `serving ref ${deployment.ref} differs from ${expectedRef}`));
  if (deployment?.git_dirty) findings.push(issue("deployment_git_dirty", "failed", "serving deployment reports dirty source"));
  if ((platform.contradictions ?? []).length) findings.push(issue("contradictory_deployment_evidence", "degraded", "Vercel list and inspect metadata disagree"));
  if (ENVIRONMENTS[environment]?.collect_platform && !platform.expected_sha) findings.push(issue("expected_sha_unknown", "degraded", "expected GitHub SHA could not be verified"));
  if ((platform.environment?.required_missing ?? []).length) findings.push(issue("required_environment_missing", "failed", `missing metadata for ${platform.environment.required_missing.join(", ")}`));
  if ((platform.logs?.recent_errors ?? []).length) findings.push(issue("recent_runtime_errors", "failed", `${platform.logs.recent_errors.length} recent runtime errors`));
  if (platform.cron?.state === "missing") findings.push(issue("cron_missing", "failed", "deployment has no cron configuration"));
  else if (!["configured", "not_applicable"].includes(platform.cron?.state)) findings.push(issue("cron_unknown", "degraded", "cron capability could not be verified"));
  if (platform.state === "unknown") findings.push(issue("platform_evidence_unknown", "degraded", "platform evidence was not collected"));

  const status = verdictFor(findings, blockers);
  const result = {
    schema_version: STATUS_SCHEMA_VERSION,
    checked_at: now,
    environment,
    ...status,
    health: { http_status: health.status, ok: health.body?.ok === true, sha: health.body?.sha ?? null, storage: health.body?.storage ?? "unknown" },
    platform,
    freshness,
    ops: {
      schema_version: root.body?.schema_version ?? null,
      capabilities: { gateway: health.body?.gateway_key_present === true ? "present" : health.body?.gateway_key_present === false ? "missing" : "unknown", callback: health.body?.runner_secret_present === true ? "present" : health.body?.runner_secret_present === false ? "missing" : "unknown", cron: platform.cron?.state ?? "unknown" },
      summary: summary.ok ? summaryBody : { evidence: summary.kind, http_status: summary.status },
      inventory: publicInventory,
      inventory_scope: inventoryScope,
      runs,
      run_correlation_scope: runCorrelationScope,
    },
    findings,
    blockers,
  };
  return redactSensitive(result, token ? [token] : []);
}

export function formatHumanStatus(status) {
  const counts = Object.entries(status.ops?.inventory ?? {}).map(([kind, value]) => `${kind}=${value.records}${value.complete ? "" : "?"}`).join(" ");
  const lines = [
    `STATUS: ${String(status.verdict).replaceAll("_", " ").toUpperCase()} (exit ${status.exit_code})`,
    `environment: ${status.environment ?? "unknown"} freshness: ${status.freshness?.state ?? "unknown"}`,
    counts ? `inventory: ${counts}` : "inventory: unavailable",
  ];
  for (const item of [...(status.blockers ?? []), ...(status.findings ?? [])].slice(0, 12)) lines.push(`- ${item.code}: ${redactSensitive(item.detail ?? "")}`);
  return lines.join("\n");
}

export async function executeCli(argv, { commandRunner = spawnCommand, fetchImpl = fetch, env = process.env, writeOut = (value) => process.stdout.write(`${value}\n`), writeErr = (value) => process.stderr.write(`${value}\n`), now = new Date().toISOString() } = {}) {
  let options;
  try {
    options = parseCliArgs(argv, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "configuration_error";
    const usage = message === "invalid_environment" || message === "environment_required" || message === "token_argument_not_allowed" || message.startsWith("usage:");
    if (usage) {
      writeErr(redactSensitive(message, env.OPS_READ_TOKEN ? [env.OPS_READ_TOKEN] : []));
      return EXIT_CODES.usage_error;
    }
    const requestedEnvironment = argv[argv.indexOf("--env") + 1] ?? "unknown";
    const result = redactSensitive({ schema_version: STATUS_SCHEMA_VERSION, checked_at: now, environment: requestedEnvironment, verdict: "failed", exit_code: EXIT_CODES.failed, health: null, platform: null, ops: null, freshness: { state: "unknown" }, findings: [issue("environment_configuration", "failed", message)], blockers: [] }, env.OPS_READ_TOKEN ? [env.OPS_READ_TOKEN] : []);
    writeOut(argv.includes("--json") ? JSON.stringify(result) : formatHumanStatus(result));
    return EXIT_CODES.failed;
  }
  try {
    const platform = options.collect_platform ? await collectPlatformEvidence({ environment: options.environment, commandRunner, env, now, target: options.vercel_target, expectedRef: options.expected_ref }) : await collectPlatformEvidence({ environment: "local", commandRunner, env, now });
    const result = await collectAgentOpsStatus({ baseUrl: options.base_url, token: options.token, fetchImpl, now, platform, environment: options.environment });
    writeOut(options.json ? JSON.stringify(result) : formatHumanStatus(result));
    return result.exit_code;
  } catch (error) {
    const result = redactSensitive({ schema_version: STATUS_SCHEMA_VERSION, checked_at: now, environment: options.environment, verdict: "failed", exit_code: EXIT_CODES.failed, health: null, platform: null, ops: null, freshness: { state: "unknown" }, findings: [issue("internal_collection_error", "failed", error instanceof Error ? error.message : "collection failed")], blockers: [] }, options.token ? [options.token] : []);
    writeOut(options.json ? JSON.stringify(result) : formatHumanStatus(result));
    return EXIT_CODES.failed;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await executeCli(process.argv.slice(2));
