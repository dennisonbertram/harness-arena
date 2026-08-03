import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { configuredSecrets, redactOpsValue } from "../../lib/ops-redaction.mjs";

export const MONITOR_SCHEMA_VERSION = "passive_agent_monitor.v1";
const MARKER_PREFIX = "<!-- harness-arena-monitor:";
const ALERT_CLASSES = Object.freeze({
  endpoint: /^(?:health_|ops_)/,
  storage: /^storage_/,
  deployment: /^(?:deployment_|expected_sha_)/,
  queue: /^(?:stale_runs|freshness_)/,
  cron: /^cron_/,
  provider: /(?:gateway|provider)/,
  capability: /(?:capability|required_environment|callback)/,
  access: /(?:_access$|access_blocked|platform_command_access)/,
});

function compact(value, maximum = 240) { return String(value ?? "").replace(/\s+/g, " ").slice(0, maximum); }
function safeHash(value) { return createHash("sha256").update(value).digest("hex").slice(0, 20); }
function allSecrets(known = []) { return [...new Set([...known, ...configuredSecrets(process.env)])].filter(Boolean); }

function scrubPromptText(value) {
  return String(value).replace(/\b(?:prompt|request[_ -]?body|body|input)\s*[:=]\s*[^,\n]*/gi, "[REDACTED_PROMPT]");
}

function removePromptFields(value) {
  if (!value || typeof value !== "object") return typeof value === "string" ? scrubPromptText(value) : value;
  if (Array.isArray(value)) return value.map(removePromptFields);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(?:prompt|request[_ -]?body|body|input)/i.test(key) ? "[REDACTED_PROMPT]" : removePromptFields(item)]));
}

export function sanitizeMonitorRecord(value, knownSecrets = []) {
  return removePromptFields(redactOpsValue(value, allSecrets(knownSecrets)));
}

export function alertClassFor(code) {
  for (const [name, expression] of Object.entries(ALERT_CLASSES)) if (expression.test(String(code))) return name;
  return "observability";
}

export function stableFingerprint({ environment, alert_class, code }) {
  const canonical = `${String(environment)}\n${String(alert_class)}\n${String(code)}`;
  return `ha-monitor-v1-${safeHash(canonical)}`;
}

function failureFromItem(item, environment, knownSecrets) {
  const code = /^[a-z0-9_]+$/i.test(String(item?.code ?? "")) ? String(item.code) : "unknown_evidence";
  const alert_class = alertClassFor(code);
  return sanitizeMonitorRecord({
    code,
    alert_class,
    fingerprint: stableFingerprint({ environment, alert_class, code }),
    severity: item?.severity === "access" ? "access" : item?.severity === "degraded" ? "degraded" : "failed",
    detail: code,
  }, knownSecrets);
}

export function buildObservation(status, { environment, monitorError, knownSecrets = [], checkedAt = new Date().toISOString() } = {}) {
  const target = environment ?? status?.environment ?? "unknown";
  if (monitorError) {
    const code = "monitor_execution_failed", alert_class = "monitor";
    return sanitizeMonitorRecord({ schema_version: MONITOR_SCHEMA_VERSION, checked_at: checkedAt, environment: target, kind: "monitor_self_failure", verdict: "failed", deployment_sha: null, failures: [{ code, alert_class, fingerprint: stableFingerprint({ environment: target, alert_class, code }), severity: "failed", detail: compact(monitorError instanceof Error ? monitorError.message : "monitor execution failed") }] }, knownSecrets);
  }
  const failures = [...(status?.findings ?? []), ...(status?.blockers ?? [])].map((item) => failureFromItem(item, target, knownSecrets));
  const unique = [...new Map(failures.map((item) => [item.fingerprint, item])).values()].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  const verdict = String(status?.verdict ?? "failed");
  return sanitizeMonitorRecord({
    schema_version: MONITOR_SCHEMA_VERSION,
    checked_at: status?.checked_at ?? checkedAt,
    environment: target,
    kind: verdict === "healthy" && unique.length === 0 ? "healthy" : verdict === "access_blocked" ? "access_blocked" : "product_failure",
    verdict,
    deployment_sha: status?.platform?.deployment?.sha ?? status?.health?.sha ?? null,
    deployment_id: status?.platform?.deployment?.id ?? null,
    request_ids: [],
    failures: unique,
  }, knownSecrets);
}

export function planIncidentTransitions({ observation, incidents = [] } = {}) {
  const current = new Map((observation?.failures ?? []).map((item) => [item.fingerprint, item]));
  const grouped = new Map();
  for (const candidate of incidents) {
    const incident = parseAutomatedIncident(candidate);
    if (!incident?.fingerprint || !Number.isInteger(incident.number)) continue;
    const prior = grouped.get(incident.fingerprint);
    if (!prior || (prior.state !== "OPEN" && incident.state === "OPEN")) grouped.set(incident.fingerprint, incident);
  }
  const actions = [];
  for (const [fingerprint, failure] of current) {
    const incident = grouped.get(fingerprint);
    if (!incident) actions.push({ action: "create", fingerprint, failure, reason: "new_failure" });
    else if (incident.state === "CLOSED") actions.push({ action: "reopen", number: incident.number, fingerprint, failure, reason: "flap" });
    else if (incident.evidence_sha && observation.deployment_sha && incident.evidence_sha !== observation.deployment_sha) actions.push({ action: "comment", number: incident.number, fingerprint, failure, reason: "deployment_changed" });
  }
  for (const incident of grouped.values()) {
    if (incident.state !== "OPEN" || current.has(incident.fingerprint)) continue;
    if (incident.recovery_pending) actions.push({ action: "close", number: incident.number, fingerprint: incident.fingerprint, reason: "recovery_proven" });
    else actions.push({ action: "comment", number: incident.number, fingerprint: incident.fingerprint, reason: "recovery_pending" });
  }
  return { schema_version: MONITOR_SCHEMA_VERSION, observation: sanitizeMonitorRecord(observation), actions: actions.sort((left, right) => `${left.number ?? 0}:${left.fingerprint}`.localeCompare(`${right.number ?? 0}:${right.fingerprint}`)) };
}

export function issueMarker({ fingerprint, recovery_pending = false, evidence_sha = null }) {
  return `${MARKER_PREFIX}${JSON.stringify({ fingerprint, recovery_pending: Boolean(recovery_pending), evidence_sha })} -->`;
}

export function parseAutomatedIncident(incident) {
  if (incident?.fingerprint) return incident;
  const match = String(incident?.body ?? "").match(/<!-- harness-arena-monitor:(\{[^\n]*?\}) -->/);
  if (!match) return null;
  try {
    const marker = JSON.parse(match[1]);
    return typeof marker.fingerprint === "string" ? { ...incident, ...marker } : null;
  } catch { return null; }
}

export function issueBodyForAction(action, observation) {
  const failure = action.failure ?? { code: "recovered", alert_class: "recovery", detail: "No longer observed" };
  const status = action.reason === "recovery_pending" ? "A healthy observation was recorded; waiting for a second consecutive check before closure." : action.reason === "recovery_proven" ? "Recovery was proven by two consecutive monitor observations." : action.reason === "flap" ? "Failure recurred after recovery." : action.reason === "deployment_changed" ? "Failure persists on a changed deployment." : "Failure detected by the passive monitor.";
  return sanitizeMonitorRecord(`${issueMarker({ fingerprint: action.fingerprint, recovery_pending: action.reason === "recovery_pending", evidence_sha: observation.deployment_sha })}\n\n## Passive monitor: ${failure.alert_class}/${failure.code}\n\n${status}\n\n- Environment: ${observation.environment}\n- Deployment SHA: ${observation.deployment_sha ?? "unavailable"}\n- Check time: ${observation.checked_at}\n- Evidence: ${failure.detail ?? "unavailable"}\n\nNo prompts, request bodies, credential values, or mutating actions are retained.`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!new Set(["--status", "--incidents", "--output", "--environment"]).has(key)) throw new Error("usage: passive-monitor.mjs --status <sanitized-status.json> --incidents <incidents.json> --output <plan.json> --environment <development|production>");
    options[key.slice(2)] = argv[++index];
  }
  if (!options.status || !options.incidents || !options.output || !["development", "production"].includes(options.environment)) throw new Error("invalid_monitor_arguments");
  return options;
}

export async function executeMonitor(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    const [statusText, incidentText] = await Promise.all([readFile(options.status, "utf8"), readFile(options.incidents, "utf8")]);
    const status = JSON.parse(statusText), incidents = JSON.parse(incidentText);
    const observation = buildObservation(status, { environment: options.environment });
    const plan = planIncidentTransitions({ observation, incidents: Array.isArray(incidents) ? incidents : [] });
    await writeFile(options.output, `${JSON.stringify(sanitizeMonitorRecord(plan))}\n`, { mode: 0o600 });
    return 0;
  } catch (error) {
    const observation = buildObservation(null, { environment: "unknown", monitorError: error });
    const plan = planIncidentTransitions({ observation, incidents: [] });
    const output = argv[argv.indexOf("--output") + 1];
    if (output) await writeFile(output, `${JSON.stringify(sanitizeMonitorRecord(plan))}\n`, { mode: 0o600 });
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await executeMonitor();
