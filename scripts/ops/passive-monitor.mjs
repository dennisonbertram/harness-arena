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

function safeCorrelationIds(status) {
  const candidates = [status?.request_id, status?.trace_id];
  for (const entry of status?.platform?.logs?.recent_errors ?? []) candidates.push(entry?.request_id, entry?.trace_id);
  return [...new Set(candidates.filter((value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value)))].slice(0, 20);
}

const STATUS_EXIT_CODES = Object.freeze({ healthy: 0, degraded: 1, failed: 2, access_blocked: 3 });

function monitorFailureObservation({ environment, code, checkedAt, knownSecrets = [] }) {
  const alert_class = "monitor";
  return sanitizeMonitorRecord({
    schema_version: MONITOR_SCHEMA_VERSION,
    checked_at: checkedAt,
    environment,
    kind: "monitor_self_failure",
    verdict: "failed",
    deployment_sha: null,
    deployment_id: null,
    request_ids: [],
    failures: [{ code, alert_class, fingerprint: stableFingerprint({ environment, alert_class, code }), severity: "failed", detail: code }],
  }, knownSecrets);
}

function validEvidenceList(value) {
  return Array.isArray(value) && value.length <= 1_000 && value.every((item) => item && typeof item === "object" && !Array.isArray(item) && /^[a-z0-9_]+$/i.test(String(item.code ?? "")));
}

function validCollectorStatus(status, environment) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return false;
  if (status.schema_version !== "agent_ops_status.v1" || status.environment !== environment) return false;
  if (!Object.hasOwn(STATUS_EXIT_CODES, status.verdict) || status.exit_code !== STATUS_EXIT_CODES[status.verdict]) return false;
  if (!validEvidenceList(status.findings) || !validEvidenceList(status.blockers)) return false;
  const evidenceCount = status.findings.length + status.blockers.length;
  if (status.verdict === "healthy") return evidenceCount === 0;
  return evidenceCount > 0;
}

export function buildObservation(status, { environment, monitorError, knownSecrets = [], checkedAt = new Date().toISOString() } = {}) {
  const target = environment ?? status?.environment ?? "unknown";
  if (monitorError) {
    return monitorFailureObservation({ environment: target, code: "monitor_execution_failed", checkedAt, knownSecrets });
  }
  if (!validCollectorStatus(status, target)) return monitorFailureObservation({ environment: target, code: "collector_output_invalid", checkedAt, knownSecrets });
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
    request_ids: safeCorrelationIds(status),
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
  if (observation?.kind === "monitor_self_failure") return { schema_version: MONITOR_SCHEMA_VERSION, observation: sanitizeMonitorRecord(observation), actions: actions.sort((left, right) => `${left.number ?? 0}:${left.fingerprint}`.localeCompare(`${right.number ?? 0}:${right.fingerprint}`)) };
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
  const correlationIds = Array.isArray(observation.request_ids) && observation.request_ids.length ? observation.request_ids.join(", ") : "unavailable";
  return sanitizeMonitorRecord(`${issueMarker({ fingerprint: action.fingerprint, recovery_pending: action.reason === "recovery_pending", evidence_sha: observation.deployment_sha })}\n\n## Passive monitor: ${failure.alert_class}/${failure.code}\n\n${status}\n\n- Environment: ${observation.environment}\n- Deployment SHA: ${observation.deployment_sha ?? "unavailable"}\n- Check time: ${observation.checked_at}\n- Correlation IDs: ${correlationIds}\n- Evidence: ${failure.detail ?? "unavailable"}\n\nNo prompts, request bodies, credential values, or mutating actions are retained.`);
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
  let options, incidents = [];
  try {
    options = parseArgs(argv);
    const incidentText = await readFile(options.incidents, "utf8");
    const parsedIncidents = JSON.parse(incidentText);
    incidents = Array.isArray(parsedIncidents) ? parsedIncidents : [];
    const statusText = await readFile(options.status, "utf8");
    const status = JSON.parse(statusText);
    const observation = buildObservation(status, { environment: options.environment });
    const plan = planIncidentTransitions({ observation, incidents });
    await writeFile(options.output, `${JSON.stringify(sanitizeMonitorRecord(plan))}\n`, { mode: 0o600 });
    return observation.kind === "monitor_self_failure" ? 2 : 0;
  } catch (error) {
    const requestedEnvironment = options?.environment ?? argv[argv.indexOf("--environment") + 1];
    const environment = ["development", "production"].includes(requestedEnvironment) ? requestedEnvironment : "unknown";
    const observation = buildObservation(null, { environment, monitorError: error });
    const plan = planIncidentTransitions({ observation, incidents });
    const output = argv[argv.indexOf("--output") + 1];
    if (output) await writeFile(output, `${JSON.stringify(sanitizeMonitorRecord(plan))}\n`, { mode: 0o600 });
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await executeMonitor();
