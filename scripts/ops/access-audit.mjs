import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { redactOpsText, redactOpsValue } from "../../lib/ops-redaction.mjs";

export const ACCESS_AUDIT_SCHEMA_VERSION = "agent_access_audit.v1";
export const ACCESS_AUDIT_EXIT_CODES = Object.freeze({ observable: 0, missing: 2, overprivileged: 3, usage_error: 64 });
const MAX_JSON_BYTES = 1024 * 1024;
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const WRITE_LEVELS = new Set(["write", "admin", "owner", "maintain", "triage", "push", "developer"]);
const VERCEL_WRITE_ROLES = new Set(["OWNER", "ADMIN", "DEVELOPER", "MEMBER"]);
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

function extension(path) {
  const match = /\.[^.]+$/.exec(path);
  return match?.[0] ?? "";
}

async function readBoundedJson(path, expectedVersion) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JSON_BYTES) throw new Error("unsafe_json_file");
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || parsed.schema_version !== expectedVersion) throw new Error("unsupported_schema_version");
  return parsed;
}

export async function loadPolicy(path) {
  const policy = await readBoundedJson(path, "agent_access_policy.v1");
  validatePolicy(policy);
  return policy;
}

export function validatePolicy(policy) {
  if (policy.policy_version !== 1 || !policy.roles?.monitor || !policy.roles?.diagnostic || !policy.environment_inventory?.variables) throw new Error("invalid_access_policy");
  const capabilityNames = new Set(Object.keys(policy.capabilities ?? {}));
  for (const role of [policy.roles.monitor, policy.roles.diagnostic]) {
    if (typeof role.purpose !== "string" || !role.purpose
      || !Array.isArray(role.capabilities) || role.capabilities.some((name) => !capabilityNames.has(name))
      || !Array.isArray(role.standing_credentials) || role.standing_credentials.some((name) => name !== "OPS_READ_TOKEN")
      || !["metadata_only", "protected_ephemeral_only"].includes(role.secret_value_access)) throw new Error("invalid_access_policy_role");
  }
  for (const [name, record] of Object.entries(policy.environment_inventory.variables)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)
      || typeof record?.purpose !== "string" || !record.purpose
      || !Array.isArray(record.environments) || record.environments.length === 0
      || typeof record.secret !== "boolean"
      || typeof record.owner !== "string" || !record.owner
      || typeof record.required !== "string" || !record.required
      || typeof record.safe_diagnostic !== "string" || !record.safe_diagnostic) throw new Error(`invalid_environment_inventory:${name}`);
  }
  if (!Array.isArray(policy.environment_inventory.source_paths)
    || !Array.isArray(policy.environment_inventory.exclude_directories)
    || !Array.isArray(policy.environment_inventory.exclude_suffixes)
    || !Array.isArray(policy.environment_inventory.approved_dynamic_access)) throw new Error("invalid_environment_inventory_config");
  return policy;
}

export function deriveEnvironmentReferencesFromText(text) {
  const names = new Set();
  const dynamics = [];
  for (const match of text.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g)) names.add(match[1]);
  for (const match of text.matchAll(/\bprocess\.env\[\s*(["'])([A-Z][A-Z0-9_]*)\1\s*\]/g)) names.add(match[2]);
  for (const match of text.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*process\.env\b/g)) {
    for (const field of match[1].split(",")) {
      const name = field.trim().replace(/^\.\.\./, "").split(/[:=]/, 1)[0].trim();
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) names.add(name);
    }
  }
  for (const match of text.matchAll(/\bprocess\.env\[\s*([^\]]+)\s*\]/g)) {
    if (/^["'][A-Z][A-Z0-9_]*["']$/.test(match[1].trim())) continue;
    const before = text.slice(0, match.index);
    dynamics.push({ accessor: match[1].trim(), line: before.split("\n").length });
  }
  return { names, dynamics };
}

async function sourceFiles(cwd, policy) {
  const files = [];
  const excludedDirectories = new Set(policy.environment_inventory.exclude_directories);
  const excludedSuffixes = policy.environment_inventory.exclude_suffixes;
  const visit = async (absolute) => {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`source_symlink_denied:${relative(cwd, absolute)}`);
    if (info.isFile()) {
      const rel = relative(cwd, absolute).replaceAll("\\", "/");
      if (SOURCE_EXTENSIONS.has(extension(rel)) && !excludedSuffixes.some((suffix) => rel.includes(suffix))) files.push(rel);
      return;
    }
    if (!info.isDirectory()) return;
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      await visit(join(absolute, entry.name));
    }
  };
  for (const target of policy.environment_inventory.source_paths) await visit(resolve(cwd, target));
  return [...new Set(files)].sort();
}

export async function discoverSourceEnvironment({ cwd, policy }) {
  const names = new Set();
  const dynamic = [];
  const files = await sourceFiles(cwd, policy);
  for (const file of files) {
    const derived = deriveEnvironmentReferencesFromText(await readFile(resolve(cwd, file), "utf8"));
    for (const name of derived.names) names.add(name);
    dynamic.push(...derived.dynamics.map((item) => ({ file, ...item })));
  }
  return { names, dynamic, files };
}

export function compareEnvironmentInventory(referenced, policy) {
  const inventory = new Set(Object.keys(policy.environment_inventory.variables));
  return [...referenced].filter((name) => !inventory.has(name)).sort();
}

export async function auditEnvironmentInventory({ cwd, policy }) {
  const discovered = await discoverSourceEnvironment({ cwd, policy });
  const approvals = new Set(policy.environment_inventory.approved_dynamic_access.map(({ file, accessor }) => `${file}:${accessor}`));
  const unapproved = discovered.dynamic.filter(({ file, accessor }) => !approvals.has(`${file}:${accessor}`));
  return {
    referenced: [...discovered.names].sort(),
    missing: compareEnvironmentInventory(discovered.names, policy),
    unapproved_dynamic: unapproved,
    scanned_files: discovered.files.length,
  };
}

function capability(name, state, reasons = []) { return { name, state, reasons: [...new Set(reasons)].sort() }; }
function missingState(value) { return !value || value.state === "missing" || value.state === "expired"; }
function levelIsWrite(value) { return WRITE_LEVELS.has(String(value ?? "").toLowerCase()); }

function auditGitHub(policy, evidence, now) {
  if (missingState(evidence)) return capability("github", "missing", ["github_identity_missing"]);
  if (evidence.expires_at) {
    const expiresAt = Date.parse(evidence.expires_at);
    if (!Number.isFinite(expiresAt)) return capability("github", "missing", ["github_identity_expiry_invalid"]);
    if (expiresAt <= Date.parse(now)) return capability("github", "missing", ["github_identity_expired"]);
  }
  const reasons = [];
  if (levelIsWrite(evidence.repository_role)) reasons.push("github_repository_role_can_write");
  for (const [permission, level] of Object.entries(evidence.permissions ?? {})) if (levelIsWrite(level)) reasons.push(`github_${permission}_can_write`);
  if (reasons.length) return capability("github", "overprivileged", reasons);
  const required = policy.capabilities.github.required_read_permissions;
  const missing = required.filter((permission) => evidence.permissions?.[permission] !== "read");
  const missingReasons = missing.map((permission) => `github_${permission}_read_missing`);
  if (!policy.capabilities.github.allowed_identity_kinds.includes(evidence.identity_kind)) missingReasons.push("github_identity_kind_unapproved");
  if (missingReasons.length) return capability("github", "missing", missingReasons);
  return capability("github", "observable");
}

function auditVercel(policy, evidence) {
  if (missingState(evidence)) return capability("vercel", "missing", ["vercel_viewer_identity_missing"]);
  const reasons = [];
  if (/owner|admin|developer/i.test(String(evidence.identity_kind ?? ""))) reasons.push("vercel_identity_kind_can_write");
  if (VERCEL_WRITE_ROLES.has(String(evidence.team_role ?? "").toUpperCase())) reasons.push("vercel_team_role_can_write");
  if (VERCEL_WRITE_ROLES.has(String(evidence.project_role ?? "").toUpperCase())) reasons.push("vercel_project_role_can_write");
  if (evidence.decrypted_environment_values) reasons.push("vercel_static_identity_can_decrypt_secrets");
  if (reasons.length) return capability("vercel", "overprivileged", reasons);
  const allowedProject = policy.capabilities.vercel.project_ids.includes(evidence.project_id);
  if (String(evidence.team_role).toUpperCase() !== "VIEWER" || String(evidence.project_role).toUpperCase() !== "VIEWER" || !allowedProject || !evidence.environment_metadata || !evidence.deployments || !evidence.logs) {
    return capability("vercel", "missing", ["vercel_viewer_evidence_incomplete"]);
  }
  return capability("vercel", "observable");
}

function auditOps(evidence) {
  if (missingState(evidence) || !evidence.token_present) return capability("get_only_ops", "missing", ["ops_read_token_missing"]);
  const methods = Array.isArray(evidence.methods) ? evidence.methods : [];
  if (methods.some((method) => method !== "GET")) return capability("get_only_ops", "overprivileged", ["ops_token_allows_non_get"]);
  const unsafe = WRITE_METHODS.filter((method) => evidence.write_probes?.[method] !== 405);
  return unsafe.length ? capability("get_only_ops", "missing", unsafe.map((method) => `ops_${method.toLowerCase()}_denial_unproven`)) : capability("get_only_ops", "observable");
}

function auditBrokered(name, evidence, expectedReadVia, credentialKey = "credential_present") {
  if (evidence?.[credentialKey]) return capability(name, "overprivileged", [`${name}_direct_credential_present`]);
  return evidence?.read_via === expectedReadVia ? capability(name, "observable") : capability(name, "missing", [`${name}_brokered_read_missing`]);
}

function auditSecrets(evidence) {
  if (evidence?.forbidden_static_values_present) return capability("secrets", "overprivileged", ["forbidden_static_secret_values_present"]);
  if (!evidence?.metadata_readable || evidence?.ephemeral_file_mode !== "0600" || !evidence?.cleanup_verified) return capability("secrets", "missing", ["protected_ephemeral_secret_handling_unproven"]);
  return capability("secrets", "observable");
}

export function auditAccessEvidence(policy, evidence, { now = new Date().toISOString() } = {}) {
  if (evidence?.schema_version !== "agent_access_evidence.v1" || !policy.roles[evidence.role]) throw new Error("invalid_access_evidence");
  const systems = [
    auditGitHub(policy, evidence.github, now),
    auditVercel(policy, evidence.vercel),
    auditOps(evidence.ops),
    auditBrokered("blob", evidence.blob, "get_only_ops"),
    auditBrokered("sandbox", evidence.sandbox, "get_only_ops"),
    auditBrokered("ai_gateway", evidence.ai_gateway, "vercel_logs", "spend_credential_present"),
    auditSecrets(evidence.secrets),
  ];
  const overall = systems.some((item) => item.state === "overprivileged") ? "overprivileged"
    : systems.some((item) => item.state === "missing") ? "missing" : "observable";
  return { schema_version: ACCESS_AUDIT_SCHEMA_VERSION, role: evidence.role, captured_at: evidence.captured_at ?? null, overall, exit_code: ACCESS_AUDIT_EXIT_CODES[overall], systems };
}

function sanitizedError(error, secret) {
  const safe = redactOpsValue(error, [secret]);
  const message = safe && typeof safe === "object" && typeof safe.message === "string"
    ? safe.message : "ephemeral secret operation failed";
  return new Error(message, { cause: undefined });
}

export async function withEphemeralSecretFile({ secret, run, parentDir = tmpdir(), signalSource = process }) {
  if (typeof secret !== "string" || !secret || typeof run !== "function") throw new Error("invalid_ephemeral_secret_request");
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parentDir);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("unsafe_ephemeral_secret_parent");
  const directory = await mkdtemp(join(parentDir, "harness-agent-secret-"));
  await chmod(directory, 0o700);
  const path = join(directory, "value");
  await writeFile(path, secret, { encoding: "utf8", flag: "wx", mode: 0o600 });
  let rejectInterrupted;
  const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => { cleanup(); rejectInterrupted(new Error(`operation interrupted by ${signal}`)); };
    handlers.set(signal, handler);
    signalSource.once(signal, handler);
  }
  try {
    const result = await Promise.race([Promise.resolve().then(() => run(path)), interrupted]);
    return redactOpsValue(result, [secret]);
  } catch (error) {
    throw sanitizedError(error, secret);
  } finally {
    for (const [signal, handler] of handlers) signalSource.removeListener(signal, handler);
    cleanup();
  }
}

function parseArgs(argv) {
  let evidencePath, json = false;
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  for (let index = 0; index < normalized.length; index += 1) {
    const arg = normalized[index];
    if (arg === "--evidence") evidencePath = normalized[++index];
    else if (arg === "--json") json = true;
    else throw new Error("usage: pnpm ops:access-audit -- --evidence <metadata.json> [--json]");
  }
  if (!evidencePath || evidencePath.startsWith("-")) throw new Error("evidence_path_required");
  return { evidencePath, json };
}

export async function executeCli(argv, { cwd = process.cwd(), writeOut = (value) => process.stdout.write(`${value}\n`), writeErr = (value) => process.stderr.write(`${value}\n`), evidenceOverride, now } = {}) {
  try {
    const args = parseArgs(argv);
    const policy = await loadPolicy(resolve(cwd, "config/agent-access-policy.json"));
    const inventory = await auditEnvironmentInventory({ cwd, policy });
    const evidence = evidenceOverride ?? await readBoundedJson(resolve(cwd, args.evidencePath), "agent_access_evidence.v1");
    let report = auditAccessEvidence(policy, evidence, { now });
    if (inventory.missing.length || inventory.unapproved_dynamic.length) report = { ...report, overall: "missing", exit_code: ACCESS_AUDIT_EXIT_CODES.missing };
    const output = redactOpsValue({ ...report, environment_inventory: inventory });
    writeOut(args.json ? JSON.stringify(output) : `${output.overall}: ${output.systems.map((item) => `${item.name}=${item.state}`).join(" ")}`);
    return report.exit_code;
  } catch (error) {
    writeErr(redactOpsText(error instanceof Error ? error.message : String(error)));
    return ACCESS_AUDIT_EXIT_CODES.usage_error;
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exitCode = await executeCli(process.argv.slice(2));
