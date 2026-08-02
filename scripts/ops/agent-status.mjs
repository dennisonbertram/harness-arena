import { spawn } from "node:child_process";

export const STATUS_SCHEMA_VERSION = "agent_ops_status.v1";
export const EXIT_CODES = Object.freeze({ healthy: 0, action_required: 2, access_blocked: 3, usage_error: 64 });
const ALLOWED_PATHS = new Set(["/api/health", "/api/ops/v1", "/api/ops/v1/summary", "/api/ops/v1/inventory"]);
const SENSITIVE_KEY = /(authorization|cookie|password|secret|token|api[_-]?key|credential)/i;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PAGES = 10;

function safeBaseUrl(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid_base_url");
  return url;
}

function safePath(path) {
  const url = new URL(path, "https://ops.invalid");
  if (!ALLOWED_PATHS.has(url.pathname)) throw new Error("unsafe_ops_path");
  return url;
}

export function redactSensitive(value, knownSecrets = []) {
  const redactText = (text) => {
    let out = String(text).replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]");
    out = out.replace(/(https?:\/\/[^\s"'<>]+)/g, (candidate) => {
      try { const url = new URL(candidate); url.search = ""; return url.toString(); } catch { return candidate; }
    });
    for (const secret of [...new Set(knownSecrets.filter((item) => typeof item === "string" && item.length >= 4))].sort((a, b) => b.length - a.length)) out = out.split(secret).join("[REDACTED]");
    return out;
  };
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, knownSecrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitive(item, knownSecrets)]));
  return typeof value === "string" ? redactText(value) : value;
}

function finding(code, detail) { return { code, detail: redactSensitive(detail) }; }

async function getJson({ baseUrl, path, token, fetchImpl, timeoutMs }) {
  const parsed = safePath(path), url = new URL(parsed.pathname, baseUrl);
  for (const [key, value] of parsed.searchParams) url.searchParams.append(key, value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try { response = await fetchImpl(url.toString(), { method: "GET", headers: token ? { authorization: `Bearer ${token}` } : {}, signal: controller.signal }); }
    catch (error) { return { status: 0, ok: false, body: { error: controller.signal.aborted ? "request_timeout" : "request_failed", detail: error instanceof Error ? error.message : "unknown" } }; }
    let body;
    try { body = await response.json(); } catch { body = { error: "invalid_json" }; }
    return { status: response.status, ok: response.ok, body: redactSensitive(body, token ? [token] : []) };
  } finally { clearTimeout(timer); }
}

function accessStatus(status) { return status === 401 || status === 403; }
function isoAgeMs(value, now) { const time = Date.parse(value ?? ""); return Number.isFinite(time) ? Math.max(0, Date.parse(now) - time) : null; }

async function inventorySnapshot(options) {
  const { baseUrl, token, fetchImpl, timeoutMs, kind = "runs" } = options;
  let cursor, pages = 0, records = 0, complete = true;
  do {
    const params = new URLSearchParams({ kind, limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const response = await getJson({ baseUrl, path: `/api/ops/v1/inventory?${params}`, token, fetchImpl, timeoutMs });
    if (!response.ok) return { records, pages, complete: false, error: accessStatus(response.status) ? "unauthorized" : `http_${response.status}` };
    const body = response.body;
    records += Array.isArray(body.items) ? body.items.length : 0;
    pages += 1;
    cursor = body.has_more ? body.next_cursor : null;
    if (cursor && pages >= MAX_PAGES) return { records, pages, complete: false, error: "page_limit" };
  } while (cursor);
  return { records, pages, complete };
}

export async function collectAgentOpsStatus({ baseUrl, token, fetchImpl = fetch, now = new Date().toISOString(), timeoutMs = DEFAULT_TIMEOUT_MS, vercel } = {}) {
  const base = safeBaseUrl(baseUrl);
  const findings = [], blockers = [];
  const health = await getJson({ baseUrl: base, path: "/api/health", token, fetchImpl, timeoutMs });
  if (!health.ok) {
    if (accessStatus(health.status)) blockers.push(finding("health_access", `HTTP ${health.status}`));
    else findings.push(finding("health_unavailable", health.body.error ?? `HTTP ${health.status}`));
    const accessBlocked = blockers.length > 0;
    return redactSensitive({ schema_version: STATUS_SCHEMA_VERSION, checked_at: now, verdict: accessBlocked ? "access_blocked" : "action_required", exit_code: accessBlocked ? EXIT_CODES.access_blocked : EXIT_CODES.action_required, health: { status: health.status }, ops: null, findings, blockers, freshness: { state: "unknown" } }, token ? [token] : []);
  }
  if (health.body.storage !== "up") findings.push(finding(`storage_${health.body.storage ?? "unknown"}`, "health storage is not up"));

  const root = await getJson({ baseUrl: base, path: "/api/ops/v1", token, fetchImpl, timeoutMs });
  if (!root.ok) {
    if (accessStatus(root.status)) blockers.push(finding("ops_access", `HTTP ${root.status}`));
    else findings.push(finding("ops_unavailable", root.body.error ?? `HTTP ${root.status}`));
    const accessBlocked = blockers.length > 0;
    return redactSensitive({ schema_version: STATUS_SCHEMA_VERSION, checked_at: now, verdict: accessBlocked ? "access_blocked" : "action_required", exit_code: accessBlocked ? EXIT_CODES.access_blocked : EXIT_CODES.action_required, health: { status: health.status, sha: health.body.sha }, ops: null, findings, blockers, freshness: { state: "unknown" } }, token ? [token] : []);
  }
  if (root.body.schema_version !== "ops.v1") findings.push(finding("ops_schema_drift", `expected ops.v1, received ${root.body.schema_version ?? "missing"}`));

  const summary = await getJson({ baseUrl: base, path: "/api/ops/v1/summary", token, fetchImpl, timeoutMs });
  if (!summary.ok) blockers.push(finding("summary_access", `HTTP ${summary.status}`));
  const inventory = summary.ok ? await inventorySnapshot({ baseUrl: base, token, fetchImpl, timeoutMs }) : { records: 0, pages: 0, complete: false, error: "summary_unavailable" };
  if (inventory.error === "unauthorized") blockers.push(finding("inventory_access", "HTTP 401 or 403"));
  else if (inventory.error) findings.push(finding(`inventory_${inventory.error}`, "inventory snapshot is incomplete"));

  const summaryBody = summary.ok ? summary.body : {};
  if (summary.ok && summaryBody.scan?.complete !== true) findings.push(finding("summary_incomplete", "ops summary scan is incomplete"));
  if ((summaryBody.run_states?.stale ?? 0) > 0) findings.push(finding("stale_runs", `${summaryBody.run_states.stale} stale runs`));
  if ((summaryBody.integrity?.unreadable ?? 0) > 0 || (summaryBody.integrity?.corrupt ?? 0) > 0 || (summaryBody.integrity?.event_holes ?? 0) > 0) findings.push(finding("ops_integrity", "ops summary reports unreadable, corrupt, or missing records"));
  const ageMs = isoAgeMs(summaryBody.latest?.runs, now);
  const freshness = ageMs === null ? { state: "unknown" } : ageMs > 60 * 60 * 1000 ? { state: "stale", age_ms: ageMs } : { state: "fresh", age_ms: ageMs };
  if (freshness.state === "stale") findings.push(finding("freshness_stale", `latest run is ${ageMs}ms old`));
  if (vercel?.deployment?.sha && health.body.sha && vercel.deployment.sha !== health.body.sha) findings.push(finding("deployment_sha_drift", "Vercel deployment SHA differs from health SHA"));

  const accessBlocked = blockers.length > 0;
  const verdict = accessBlocked ? "access_blocked" : findings.length ? "action_required" : "healthy";
  const exit_code = accessBlocked ? EXIT_CODES.access_blocked : findings.length ? EXIT_CODES.action_required : EXIT_CODES.healthy;
  return redactSensitive({ schema_version: STATUS_SCHEMA_VERSION, checked_at: now, verdict, exit_code, health: { status: health.status, ok: health.body.ok === true, sha: health.body.sha, storage: health.body.storage }, ops: { schema_version: root.body.schema_version, summary: summary.ok ? summaryBody : { status: summary.status }, inventory: { runs: inventory } }, vercel: vercel ? redactSensitive(vercel, token ? [token] : []) : undefined, freshness, findings, blockers }, token ? [token] : []);
}

export function createVercelCommandAdapter(run) {
  return { async run(args) {
    const allowed = new Set(["ls", "inspect", "env", "logs"]);
    if (!Array.isArray(args) || !allowed.has(args[0]) || args.some((arg) => typeof arg !== "string" || /(?:--token|=token|authorization|secret)/i.test(arg))) throw new Error("unsafe_vercel_command");
    return run("vercel", args, { timeoutMs: DEFAULT_TIMEOUT_MS });
  } };
}

export function parseVercelOutput(result) {
  if (!result || result.exitCode !== 0) return { state: "unavailable", exit_code: result?.exitCode ?? 1 };
  try {
    const value = JSON.parse(result.stdout);
    const deployments = Array.isArray(value) ? value : Array.isArray(value.deployments) ? value.deployments : [];
    return redactSensitive({ state: "ok", deployments: deployments.map((deployment) => ({ id: deployment.uid ?? deployment.id, sha: deployment.meta?.githubCommitSha ?? deployment.gitSource?.sha ?? deployment.sha, readyState: deployment.readyState ?? deployment.state })), environment_names: (value.envs ?? value.environments ?? []).map((entry) => entry.key ?? entry.name).filter((entry) => typeof entry === "string") });
  } catch { return { state: "invalid_json" }; }
}

export async function collectVercelStatus(adapter, target) {
  const [listed, inspected, environment, logs] = await Promise.all([
    adapter.run(["ls", "--json"]),
    target ? adapter.run(["inspect", target, "--json"]) : Promise.resolve(null),
    adapter.run(["env", "ls", "--json"]),
    target ? adapter.run(["logs", target, "--json"]) : Promise.resolve(null),
  ]);
  return { list: parseVercelOutput(listed), inspect: inspected ? parseVercelOutput(inspected) : undefined, env: parseVercelOutput(environment), logs: logs ? parseVercelOutput(logs) : undefined };
}

export async function spawnCommand(binary, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("command_timeout")); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); }); child.on("close", (exitCode) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: exitCode ?? 1 }); });
  });
}

export function formatHumanStatus(status) {
  const lines = [`${status.verdict.replaceAll("_", " ").toUpperCase()} (exit ${status.exit_code})`, `freshness: ${status.freshness?.state ?? "unknown"}`];
  for (const item of [...(status.blockers ?? []), ...(status.findings ?? [])]) lines.push(`- ${item.code}: ${redactSensitive(item.detail ?? "")}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { json: false, baseUrl: process.env.HARNESS_ARENA_OPS_URL, token: process.env.OPS_READ_TOKEN };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") options.json = true;
    else if (argv[i] === "--base-url") options.baseUrl = argv[++i];
    else if (argv[i] === "--token") throw new Error("token_argument_not_allowed");
    else throw new Error("usage: ops:status [--json] --base-url <url>");
  }
  if (!options.baseUrl) throw new Error("usage: ops:status [--json] --base-url <url>");
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { const options = parseArgs(process.argv.slice(2)); const result = await collectAgentOpsStatus(options); console.log(options.json ? JSON.stringify(result) : formatHumanStatus(result)); process.exitCode = result.exit_code; }
  catch (error) { console.error(redactSensitive(error instanceof Error ? error.message : "usage_error")); process.exitCode = EXIT_CODES.usage_error; }
}
