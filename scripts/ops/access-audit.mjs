import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { redactOpsText, redactOpsValue } from "../../lib/ops-redaction.mjs";
import { credentialSeparationAttestation, OPS_READ_SEPARATE_FROM } from "../../lib/credential-separation.mjs";
import { spawnCommand } from "./agent-status.mjs";

export const ACCESS_AUDIT_SCHEMA_VERSION = "agent_access_audit.v1";
export const ACCESS_AUDIT_EXIT_CODES = Object.freeze({ observable: 0, missing: 2, overprivileged: 3, usage_error: 64 });
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_VERCEL_PAGES = 100;
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const WRITE_LEVELS = new Set(["write", "admin", "owner", "maintain", "triage", "push", "developer"]);
const VERCEL_WRITE_ROLES = new Set(["OWNER", "ADMIN", "DEVELOPER", "MEMBER", "CONTRIBUTOR", "SECURITY", "BILLING"]);
const VERCEL_READ_ONLY_PERMISSIONS = new Set(["OrgViewer", "UsageViewer", "V0Viewer"]);
const VERCEL_ROLE_RANK = new Map([["GUEST", 0], ["VIEWER", 1], ["VIEWER_FOR_PLUS", 1], ["BILLING", 2], ["SECURITY", 2], ["CONTRIBUTOR", 3], ["MEMBER", 4], ["DEVELOPER", 5], ["ADMIN", 6], ["OWNER", 7]]);

function extension(path) {
  const match = /\.[^.]+$/.exec(path);
  return match?.[0] ?? "";
}

async function readBoundedJson(path, expectedVersion) {
  let info;
  try { info = await lstat(path); } catch { throw new Error("json_file_unavailable"); }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JSON_BYTES) throw new Error("unsafe_json_file");
  let parsed;
  try { parsed = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("invalid_json"); }
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
  if (JSON.stringify(policy.capabilities?.get_only_ops?.separate_from) !== JSON.stringify(OPS_READ_SEPARATE_FROM)) throw new Error("invalid_credential_separation_policy");
  const targets = policy.capabilities?.get_only_ops?.targets;
  if (!targets || !["production", "development", "local"].every((name) => Array.isArray(targets[name]?.hosts) && targets[name].hosts.length > 0)) throw new Error("invalid_ops_target_policy");
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
    files: discovered.files,
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

function normalizeVercelRole(role) {
  const value = role ? String(role).trim().toUpperCase().replaceAll("-", "_") : null;
  if (value === "PROJECT_VIEWER") return "VIEWER";
  if (value === "PROJECT_DEVELOPER") return "DEVELOPER";
  if (value === "PROJECT_ADMIN") return "ADMIN";
  if (value === "PROJECT_GUEST") return "GUEST";
  return value;
}

function strongestVercelRole(roles) {
  return roles.map(normalizeVercelRole).filter(Boolean).sort((left, right) => (VERCEL_ROLE_RANK.get(right) ?? 99) - (VERCEL_ROLE_RANK.get(left) ?? 99))[0] ?? null;
}

function grantStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(grantStrings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(grantStrings);
}

export function normalizeVercelAccess({ projectId, userId, token = {}, team = {}, project = {}, projectMembers = [], accessGroups = [], accessGroupProjects = [], accessGroupMemberships = [], extendedPermissionsComplete = true }) {
  const tokenProjectId = token.projectId ?? token.project_id ?? token.scope?.projectId ?? null;
  const membership = team.membership ?? {};
  const matchingProjectMembers = (Array.isArray(projectMembers) ? projectMembers : [])
    .filter((item) => [item.uid, item.userId, item.id].includes(userId));
  const matchingGroupMemberships = (Array.isArray(accessGroupMemberships) ? accessGroupMemberships : [])
    .filter((item) => [item.uid, item.userId, item.id, item.user?.id].includes(userId));
  const groupIds = new Set(matchingGroupMemberships.map((item) => item.accessGroupId ?? item.access_group_id).filter(Boolean));
  const matchingGroups = (Array.isArray(accessGroups) ? accessGroups : [])
    .filter((item) => groupIds.has(item.accessGroupId ?? item.access_group_id ?? item.id ?? item.uid));
  const groupTeamRoles = matchingGroupMemberships.flatMap((item) => [item.teamRole, ...(Array.isArray(item.teamRoles) ? item.teamRoles : [])]);
  const accessGroupTeamRoles = matchingGroups.flatMap((item) => Array.isArray(item.teamRoles) ? item.teamRoles : []);
  const projectMemberTeamRoles = matchingProjectMembers.map((item) => item.teamRole);
  const teamRoles = [...(Array.isArray(membership.teamRoles) ? membership.teamRoles : []), ...projectMemberTeamRoles, ...groupTeamRoles, ...accessGroupTeamRoles, membership.role, team.currentUserRole, team.role].filter(Boolean);
  const teamRole = strongestVercelRole(teamRoles);
  const directRoles = matchingProjectMembers.flatMap((item) => [item.computedProjectRole, item.role]).filter(Boolean);
  const groupRoles = (Array.isArray(accessGroupProjects) ? accessGroupProjects : [])
    .filter((item) => groupIds.has(item.accessGroupId ?? item.access_group_id))
    .filter((item) => (item.projectId ?? item.project_id) === projectId).map((item) => item.role);
  const explicitRoles = [...directRoles, ...groupRoles, project.membership?.role, project.currentUserRole, project.role].filter(Boolean);
  const projectRole = strongestVercelRole([...teamRoles, ...explicitRoles]);
  return {
    project_id: project.id ?? project.uid ?? projectId ?? null,
    token_project_id: tokenProjectId,
    team_role: normalizeVercelRole(teamRole),
    project_role: projectRole,
    role_source: groupRoles.length ? "access_group_effective" : explicitRoles.length ? "project_explicit" : teamRole ? "team_inherited" : "unknown",
    team_roles: [...new Set(teamRoles.map(normalizeVercelRole))],
    team_permissions: [...new Set([
      ...(Array.isArray(membership.teamPermissions) ? membership.teamPermissions : []),
      ...matchingGroupMemberships.flatMap((item) => grantStrings(item.teamPermissions ?? item.permissions ?? item.extendedPermissions ?? item.extended_permissions ?? item.grants)),
      ...matchingGroups.flatMap((item) => grantStrings(item.teamPermissions)),
    ])].sort(),
    extended_permissions_complete: extendedPermissionsComplete
      && Array.isArray(membership.teamRoles) && Array.isArray(membership.teamPermissions)
      && matchingGroupMemberships.every((item) => (typeof item.teamRole === "string" || Array.isArray(item.teamRoles))
        && (matchingGroups.some((group) => (group.accessGroupId ?? group.access_group_id ?? group.id ?? group.uid) === (item.accessGroupId ?? item.access_group_id))
          || Array.isArray(item.teamPermissions) || Array.isArray(item.permissions) || Array.isArray(item.extendedPermissions) || Array.isArray(item.extended_permissions) || Array.isArray(item.grants)))
      && matchingGroups.every((item) => Array.isArray(item.teamRoles) && Array.isArray(item.teamPermissions)),
  };
}

export function selectActiveVercelToken(tokensResponse, tokenValue) {
  const tokens = Array.isArray(tokensResponse?.tokens) ? tokensResponse.tokens : [];
  const matches = tokens.filter((item) => (!item.prefix || tokenValue.startsWith(item.prefix)) && (!item.suffix || tokenValue.endsWith(item.suffix)));
  if (matches.length !== 1) return {};
  const selected = matches[0];
  const projectScope = (selected.scopes ?? []).find((scope) => scope?.type === "project" || scope?.projectId || scope?.project?.id);
  return {
    projectId: projectScope?.projectId ?? projectScope?.project?.id ?? null,
    expiresAt: selected.expiresAt ?? null,
    type: selected.type ?? null,
  };
}

function auditVercel(policy, evidence) {
  if (missingState(evidence)) return capability("vercel", "missing", ["vercel_viewer_identity_missing"]);
  const teamRole = normalizeVercelRole(evidence.team_role);
  const projectRole = normalizeVercelRole(evidence.project_role);
  const reasons = [];
  if (/owner|admin|developer/i.test(String(evidence.identity_kind ?? ""))) reasons.push("vercel_identity_kind_can_write");
  if (VERCEL_WRITE_ROLES.has(teamRole)) reasons.push("vercel_team_role_can_write");
  if (VERCEL_WRITE_ROLES.has(projectRole)) reasons.push("vercel_project_role_can_write");
  for (const permission of evidence.team_permissions ?? []) if (!VERCEL_READ_ONLY_PERMISSIONS.has(permission)) reasons.push(`vercel_${permission}_can_write`);
  if (evidence.decrypted_environment_values) reasons.push("vercel_static_identity_can_decrypt_secrets");
  if (reasons.length) return capability("vercel", "overprivileged", reasons);
  if (evidence.extended_permissions_complete !== true) return capability("vercel", "missing", ["vercel_extended_permissions_unverifiable"]);
  const allowedProject = policy.capabilities.vercel.project_ids.includes(evidence.project_id)
    && (!evidence.token_project_id || evidence.token_project_id === evidence.project_id);
  if (teamRole !== "VIEWER" || projectRole !== "VIEWER" || !allowedProject || !evidence.environment_metadata || !evidence.deployments || !evidence.logs) {
    return capability("vercel", "missing", ["vercel_viewer_evidence_incomplete"]);
  }
  return capability("vercel", "observable");
}

function auditOps(evidence) {
  if (missingState(evidence) || !evidence.token_present) return capability("get_only_ops", "missing", ["ops_read_token_missing"]);
  const methods = Array.isArray(evidence.methods) ? evidence.methods : [];
  if (!methods.includes("GET")) return capability("get_only_ops", "missing", ["ops_get_read_unproven"]);
  if (methods.some((method) => method !== "GET")) return capability("get_only_ops", "overprivileged", ["ops_token_allows_non_get"]);
  if (evidence.get_probes && Object.values(evidence.get_probes).some((status) => status !== 200)) return capability("get_only_ops", "missing", ["ops_get_read_failed"]);
  if (evidence.credential_separation_attested !== true) return capability("get_only_ops", "missing", ["ops_credential_separation_unattested"]);
  if (evidence.credential_collisions?.length) return capability("get_only_ops", "overprivileged", ["ops_credential_collision"]);
  if (evidence.mutation_route_coverage?.complete !== true) return capability("get_only_ops", "missing", ["ops_mutation_route_coverage_unproven"]);
  if (evidence.target?.environment !== "development"
    || evidence.mutation_denial?.environment !== "development"
    || evidence.mutation_denial?.status !== 405
    || evidence.mutation_denial?.allow !== "GET") {
    return capability("get_only_ops", "missing", ["ops_development_mutation_denial_unproven"]);
  }
  if (!/^[0-9a-f]{40}$/i.test(evidence.deployed_source?.sha ?? "")
    || evidence.deployed_source?.sha !== evidence.deployed_source?.source_sha
    || evidence.deployed_source?.hostname !== evidence.target?.hostname
    || evidence.deployed_source?.project_id !== evidence.target?.project_id
    || !/^dpl_[A-Za-z0-9]+$/.test(evidence.deployed_source?.deployment_id ?? "")
    || typeof evidence.deployed_source?.deployment_url !== "string"
    || !evidence.deployed_source.deployment_url
    || evidence.deployed_source.deployment_url === evidence.target?.hostname) {
    return capability("get_only_ops", "missing", ["ops_deployed_source_identity_unproven"]);
  }
  return capability("get_only_ops", "observable");
}

function auditBrokered(name, evidence, expectedReadVia, credentialKey = "credential_present") {
  if (evidence?.[credentialKey]) return capability(name, "overprivileged", [`${name}_direct_credential_present`]);
  return evidence?.read_via === expectedReadVia ? capability(name, "observable") : capability(name, "missing", [`${name}_brokered_read_missing`]);
}

function auditSecrets(policy, roleName, evidence) {
  if (evidence?.forbidden_static_values_present) return capability("secrets", "overprivileged", ["forbidden_static_secret_values_present"]);
  if (!evidence?.metadata_readable) return capability("secrets", "missing", ["secret_metadata_read_missing"]);
  const access = policy.roles[roleName].secret_value_access;
  if (access === "metadata_only") {
    if (evidence.secret_values_accessed) return capability("secrets", "overprivileged", ["monitor_secret_value_access_forbidden"]);
    return capability("secrets", "observable");
  }
  if (evidence.secret_values_accessed && (evidence.ephemeral_file_mode !== "0600" || !evidence.cleanup_verified)) return capability("secrets", "missing", ["protected_ephemeral_secret_handling_unproven"]);
  return capability("secrets", "observable");
}

export function auditAccessEvidence(policy, evidence, { now = new Date().toISOString(), authority = "offline" } = {}) {
  if (evidence?.schema_version !== "agent_access_evidence.v1" || !policy.roles[evidence.role]) throw new Error("invalid_access_evidence");
  const systems = [
    auditGitHub(policy, evidence.github, now),
    auditVercel(policy, evidence.vercel),
    auditOps(evidence.ops),
    auditBrokered("blob", evidence.blob, "get_only_ops"),
    auditBrokered("sandbox", evidence.sandbox, "get_only_ops"),
    auditBrokered("ai_gateway", evidence.ai_gateway, "vercel_logs", "spend_credential_present"),
    auditSecrets(policy, evidence.role, evidence.secrets),
  ];
  let overall = systems.some((item) => item.state === "overprivileged") ? "overprivileged"
    : systems.some((item) => item.state === "missing") ? "missing" : "observable";
  if (authority !== "authoritative" && overall === "observable") {
    overall = "missing";
    systems.push(capability("proof_authority", "missing", ["offline_evidence_not_authoritative"]));
  }
  return { schema_version: ACCESS_AUDIT_SCHEMA_VERSION, authority, role: evidence.role, captured_at: evidence.captured_at ?? null, overall, exit_code: ACCESS_AUDIT_EXIT_CODES[overall], systems };
}

const PROTECTED_MUTATION_GUARDS = Object.freeze([
  { marker: "competitionAdminToken", credential: "COMPETITION_ADMIN_TOKEN", header: "x-competition-admin-token" },
  { marker: "verifyRunnerSecret", credential: "RUNNER_CALLBACK_SECRET", header: "x-runner-secret" },
]);

export async function deriveProtectedMutationRoutes({ cwd }) {
  const routes = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(absolute); continue; }
      if (entry.name !== "route.ts") continue;
      const file = relative(cwd, absolute).replaceAll("\\", "/");
      const source = await readFile(absolute, "utf8");
      const guard = PROTECTED_MUTATION_GUARDS.find(({ marker }) => source.includes(marker));
      if (!guard) continue;
      for (const match of source.matchAll(/export\s+(?:async\s+function|const)\s+(POST|PUT|PATCH|DELETE)\b/g)) {
        routes.push({ file, method: match[1], credential: guard.credential, header: guard.header });
      }
    }
  };
  await visit(resolve(cwd, "app/api"));
  return routes.sort((left, right) => `${left.file}:${left.method}`.localeCompare(`${right.file}:${right.method}`));
}

const OPS_MUTATION_METHODS = Object.freeze(["POST", "PUT", "PATCH", "DELETE"]);

function canonicalOpsDenials(source) {
  if (!/export\s+const\s+methodNotAllowed\s*=/.test(source)) return new Set();
  const names = new Set(["methodNotAllowed"]);
  for (const declaration of source.matchAll(/export\s+const\s+([^;]+);/g)) {
    for (const entry of declaration[1].split(",")) {
      const match = /^\s*([A-Za-z_$][\w$]*)\s*=\s*methodNotAllowed\s*$/.exec(entry);
      if (match) names.add(match[1]);
    }
  }
  return names;
}

function exportedMutationHandlers(source, canonicalDenials) {
  const handlers = [];
  for (const match of source.matchAll(/export\s+(?:async\s+function|const)\s+(POST|PUT|PATCH|DELETE)\b/g)) {
    handlers.push({ method: match[1], source: match[1], canonical_denial: false });
  }
  for (const match of source.matchAll(/export\s*{([^}]+)}(?:\s+from\s+(["'])([^"']+)\2)?/g)) {
    const moduleSpecifier = match[3] ?? null;
    for (const raw of match[1].split(",")) {
      const parts = raw.trim().split(/\s+as\s+/i);
      const sourceName = parts[0];
      const exportedName = parts[1] ?? sourceName;
      if (!OPS_MUTATION_METHODS.includes(exportedName)) continue;
      handlers.push({
        method: exportedName,
        source: sourceName,
        canonical_denial: moduleSpecifier === "@/lib/ops-route" && canonicalDenials.has(sourceName),
      });
    }
  }
  return handlers.sort((left, right) => OPS_MUTATION_METHODS.indexOf(left.method) - OPS_MUTATION_METHODS.indexOf(right.method));
}

export async function deriveOpsMutationRouteCoverage({ cwd }) {
  const routes = [];
  const root = resolve(cwd, "app/api/ops");
  const canonicalDenials = canonicalOpsDenials(await readFile(resolve(cwd, "lib/ops-route.ts"), "utf8"));
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(absolute); continue; }
      if (entry.name !== "route.ts") continue;
      const file = relative(cwd, absolute).replaceAll("\\", "/");
      const pathname = `/${file.replace(/^app\//, "").replace(/\/route\.ts$/, "")}`;
      const handlers = exportedMutationHandlers(await readFile(absolute, "utf8"), canonicalDenials);
      routes.push({ file, pathname, handlers, complete: handlers.every((handler) => handler.canonical_denial) });
    }
  };
  await visit(root);
  routes.sort((left, right) => left.pathname.localeCompare(right.pathname));
  return {
    source_files: routes.map(({ file }) => file),
    routes,
    complete: routes.length > 0 && routes.every((route) => route.complete),
  };
}

async function runJsonCommand(commandRunner, binary, args, options = {}) {
  const result = await commandRunner(binary, args, { timeoutMs: 10_000, maxBufferBytes: MAX_JSON_BYTES, ...options });
  if (result?.exitCode !== 0) throw new Error(`${binary}_read_probe_failed`);
  try { return JSON.parse(result.stdout); } catch { throw new Error(`${binary}_read_probe_invalid_json`); }
}

async function runReadCommand(commandRunner, binary, args, options = {}) {
  const result = await commandRunner(binary, args, { timeoutMs: 10_000, maxBufferBytes: MAX_JSON_BYTES, ...options });
  if (result?.exitCode !== 0) throw new Error(`${binary}_read_probe_failed`);
  return result.stdout;
}

function githubRepositoryRole(permissions = {}) {
  if (permissions.admin) return "admin";
  if (permissions.push) return "write";
  if (permissions.maintain) return "maintain";
  if (permissions.triage) return "triage";
  return permissions.pull ? "read" : "none";
}

async function probeGitHub(policy, env, commandRunner) {
  if (!env.GH_TOKEN) throw new Error("github_explicit_identity_missing");
  const commandOptions = { env: { PATH: env.PATH ?? process.env.PATH, GH_TOKEN: env.GH_TOKEN } };
  const repository = policy.capabilities.github.repository;
  let identity, identityKind, installationRepositoryRole = null;
  try {
    identity = await runJsonCommand(commandRunner, "gh", ["api", "user"], commandOptions);
    identityKind = "authenticated_user";
  } catch {
    const installation = await runJsonCommand(commandRunner, "gh", ["api", "installation/repositories"], commandOptions);
    if (!Number.isInteger(installation?.total_count) || installation.total_count < 0
      || !Array.isArray(installation?.repositories) || installation.total_count < installation.repositories.length
      || !["all", "selected"].includes(installation.repository_selection)) throw new Error("github_app_repository_scope_invalid");
    const installationRepository = installation.repositories.find((item) => item?.full_name === repository);
    const repositoryPermissions = installationRepository?.permissions;
    if (!installationRepository || !plainObject(repositoryPermissions)
      || typeof repositoryPermissions.pull !== "boolean" || typeof repositoryPermissions.push !== "boolean"
      || typeof repositoryPermissions.admin !== "boolean") throw new Error("github_app_repository_permissions_invalid");
    identity = { login: installationRepository.owner?.login ?? "github-app" };
    installationRepositoryRole = githubRepositoryRole(repositoryPermissions);
    identityKind = "github_app";
  }
  const endpoints = {
    repository: `repos/${repository}`,
    actions: `repos/${repository}/actions/runs?per_page=1`,
    issues: `repos/${repository}/issues?per_page=1`,
    pull_requests: `repos/${repository}/pulls?per_page=1`,
  };
  const responses = {};
  for (const [name, endpoint] of Object.entries(endpoints)) responses[name] = await runJsonCommand(commandRunner, "gh", ["api", endpoint], commandOptions);
  const repositoryRole = githubRepositoryRole(responses.repository.permissions);
  return {
    state: "authenticated",
    identity_kind: identityKind,
    identity: identity.login ?? identity.slug ?? null,
    repository_role: levelIsWrite(installationRepositoryRole) ? installationRepositoryRole : repositoryRole,
    expires_at: null,
    // Repository GETs establish endpoint reachability and coarse repository
    // access only. They do not establish the five independent GitHub
    // permissions required by this policy, particularly for a fine-grained
    // PAT. Keep this empty until an authoritative token permission map is
    // supplied (for example, a GitHub App installation permission response).
    permissions: {},
  };
}

async function safeGetJson(fetchImpl, url, headers = {}) {
  let response;
  try { response = await fetchImpl(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(10_000) }); }
  catch { throw new Error("read_probe_transport_failed"); }
  if (!response?.ok) throw new Error("read_probe_access_failed");
  let text;
  try { text = await response.text(); } catch { throw new Error("read_probe_body_failed"); }
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error("read_probe_body_limit");
  try { return JSON.parse(text); } catch { throw new Error("read_probe_invalid_json"); }
}

function projectMemberNext(page) {
  const pagination = page?.pagination;
  if (!Array.isArray(page?.members) || !plainObject(pagination)
    || typeof pagination.hasNext !== "boolean" || !Number.isFinite(pagination.count)
    || !Object.hasOwn(pagination, "next") || !Object.hasOwn(pagination, "prev")) throw new Error("vercel_project_members_schema_invalid");
  if (pagination.count !== page.members.length || (pagination.next !== null && !Number.isFinite(pagination.next))) throw new Error("vercel_project_members_schema_invalid");
  if (pagination.hasNext !== (pagination.next !== null)) throw new Error("vercel_project_members_pagination_inconsistent");
  return pagination.next;
}

function accessGroupNext(page, collection) {
  if (!Array.isArray(page?.[collection]) || !plainObject(page?.pagination)
    || !Object.hasOwn(page.pagination, "count") || !Object.hasOwn(page.pagination, "next")) throw new Error("vercel_access_group_schema_invalid");
  if (!Number.isInteger(page.pagination.count) || page.pagination.count < 0 || page.pagination.count !== page[collection].length) throw new Error("vercel_access_group_count_invalid");
  const next = page.pagination.next;
  if (next === null) return null;
  if (typeof next !== "string" || !next) throw new Error("vercel_access_group_pagination_invalid");
  return next;
}

export async function getProjectMemberPages({ fetchImpl, headers, url }) {
  const entries = [];
  const sinceValues = new Set();
  let since = null;
  for (let pageNumber = 0; pageNumber < MAX_VERCEL_PAGES; pageNumber += 1) {
    const target = new URL(url);
    target.searchParams.set("limit", "100");
    if (since !== null) target.searchParams.set("since", String(since));
    const page = await safeGetJson(fetchImpl, target.href, headers);
    since = projectMemberNext(page);
    entries.push(...page.members);
    if (since === null) return entries;
    if (sinceValues.has(since)) throw new Error("vercel_project_members_pagination_repeated");
    sinceValues.add(since);
  }
  throw new Error("vercel_project_members_pagination_limit_exceeded");
}

export async function getAccessGroupPages({ fetchImpl, headers, url, collection }) {
  const entries = [];
  const nextValues = new Set();
  let next = null;
  for (let pageNumber = 0; pageNumber < MAX_VERCEL_PAGES; pageNumber += 1) {
    const target = new URL(url);
    target.searchParams.set("limit", "100");
    if (next !== null) target.searchParams.set("next", String(next));
    const page = await safeGetJson(fetchImpl, target.href, headers);
    next = accessGroupNext(page, collection);
    entries.push(...page[collection]);
    if (next === null) return entries;
    const key = String(next);
    if (nextValues.has(key)) throw new Error("vercel_access_group_pagination_repeated");
    nextValues.add(key);
  }
  throw new Error("vercel_access_group_pagination_limit_exceeded");
}

async function getAccessGroupListPages(options) {
  return await getAccessGroupPages({ ...options, collection: "accessGroups" });
}

async function getAccessGroupMemberPages(options) {
  return await getAccessGroupPages({ ...options, collection: "members" });
}

async function getAccessGroupProjectPages(options) {
  return await getAccessGroupPages({ ...options, collection: "projects" });
}

export function resolveOpsTarget(policy, { url: value, projectId }) {
  let url;
  try { url = new URL(value); } catch { throw new Error("ops_target_invalid"); }
  if (url.username || url.password || !["", "/"].includes(url.pathname) || url.search || url.hash) throw new Error("ops_target_invalid");
  const targets = policy.capabilities.get_only_ops.targets;
  for (const [environment, target] of Object.entries(targets)) {
    if (!target.hosts.includes(url.hostname)) continue;
    if (target.https_required && url.protocol !== "https:") throw new Error("ops_target_invalid");
    if (target.https_required && url.port) throw new Error("ops_target_invalid");
    if (!target.https_required && !["http:", "https:"].includes(url.protocol)) throw new Error("ops_target_invalid");
    if ((target.project_id ?? null) !== (projectId ?? null)) throw new Error("ops_target_invalid");
    return { environment, project_id: target.project_id, hostname: url.hostname, origin: url.origin };
  }
  throw new Error("ops_target_invalid");
}

function plainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validAttestation(value) {
  return plainObject(value)
    && value.schema_version === "credential_separation.v1"
    && value.state === "ok"
    && Number.isInteger(value.checked_count) && value.checked_count >= 0
    && value.policy_size === OPS_READ_SEPARATE_FROM.length;
}
function validHealth(value) { return plainObject(value) && value.ok === true && validAttestation(value.credential_separation); }
function validRoot(value) {
  return plainObject(value) && value.schema_version === "ops.v1" && validAttestation(value.credential_separation)
    && value.inventory === "/api/ops/v1/inventory" && value.summary === "/api/ops/v1/summary"
    && Array.isArray(value.kinds) && value.kinds.some((item) => /^[a-z][a-z0-9_]*$/.test(typeof item === "string" ? item : item?.kind ?? ""));
}
function validInventory(value, kind) {
  return plainObject(value) && value.schema_version === "ops.v1" && value.kind === kind
    && Array.isArray(value.items) && typeof value.has_more === "boolean"
    && (value.next_cursor === null || typeof value.next_cursor === "string");
}
function validSummary(value) {
  return plainObject(value) && value.schema_version === "ops.v1"
    && plainObject(value.counts) && plainObject(value.latest) && plainObject(value.run_states)
    && plainObject(value.integrity) && plainObject(value.scan);
}

async function fetchOpsJson(fetchImpl, url, { origin, token }) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let response;
  try { response = await fetchImpl(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(10_000) }); }
  catch { throw new Error("ops_get_probe_failed"); }
  if (!response?.ok || response.status !== 200 || response.redirected === true) throw new Error("ops_get_probe_failed");
  if (response.url) {
    let responseUrl;
    try { responseUrl = new URL(response.url); } catch { throw new Error("ops_get_probe_failed"); }
    if (responseUrl.origin !== origin) throw new Error("ops_get_probe_failed");
  }
  let text;
  try { text = await response.text(); } catch { throw new Error("ops_get_probe_failed"); }
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error("ops_get_probe_failed");
  try { return JSON.parse(text); } catch { throw new Error("ops_get_probe_failed"); }
}

function vercelDeploymentAliases(value) {
  return [...(Array.isArray(value?.aliases) ? value.aliases : []), ...(Array.isArray(value?.alias) ? value.alias : [])]
    .flatMap((item) => typeof item === "string" ? [item] : typeof item?.domain === "string" ? [item.domain] : []);
}

async function deployedOpsSourceIdentity({ commandRunner, fetchImpl, env, target, cwd }) {
  if (!env.VERCEL_TOKEN) throw new Error("ops_deployment_identity_missing");
  const commandOptions = { cwd, env: { PATH: env.PATH ?? process.env.PATH, VERCEL_TOKEN: env.VERCEL_TOKEN, VERCEL_ORG_ID: env.VERCEL_TEAM_ID ?? "", VERCEL_PROJECT_ID: target.project_id ?? "" } };
  const inspection = await runJsonCommand(commandRunner, "vercel", ["inspect", target.hostname, "--json"], commandOptions);
  const deploymentId = inspection?.id ?? inspection?.uid ?? null;
  const deploymentUrl = inspection?.url ?? null;
  if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId ?? "")
    || typeof deploymentUrl !== "string" || !/^[A-Za-z0-9.-]+$/.test(deploymentUrl)
    || deploymentUrl === target.hostname
    || !vercelDeploymentAliases(inspection).includes(target.hostname)) throw new Error("ops_deployment_resolution_invalid");
  const headers = { authorization: `Bearer ${env.VERCEL_TOKEN}` };
  const deployment = await safeGetJson(fetchImpl,
    `https://api.vercel.com/v13/deployments/${encodeURIComponent(deploymentId)}?withGitRepoInfo=true&teamId=${encodeURIComponent(env.VERCEL_TEAM_ID ?? "")}`,
    headers);
  const projectId = deployment?.projectId ?? deployment?.project?.id ?? null;
  const sha = deployment?.gitSource?.sha ?? null;
  if (deployment?.id !== deploymentId || deployment?.url !== deploymentUrl
    || !vercelDeploymentAliases(deployment).includes(target.hostname)
    || projectId !== target.project_id || !/^[0-9a-f]{40}$/i.test(sha ?? "")) throw new Error("ops_deployment_identity_invalid");
  const local = await runReadCommand(commandRunner, "git", ["rev-parse", "HEAD"], { cwd });
  const sourceSha = local.trim();
  if (!/^[0-9a-f]{40}$/i.test(sourceSha) || sourceSha.toLowerCase() !== sha.toLowerCase()) throw new Error("ops_deployment_source_mismatch");
  return {
    hostname: target.hostname,
    deployment_id: deploymentId,
    deployment_url: deploymentUrl,
    project_id: projectId,
    sha: sha.toLowerCase(),
    source_sha: sourceSha.toLowerCase(),
  };
}

async function probeOpsMutationDenial(fetchImpl, target, token) {
  if (target.environment !== "development") throw new Error("ops_mutation_probe_development_only");
  let response;
  try {
    response = await fetchImpl(`${target.origin}/api/ops/v1`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new Error("ops_mutation_probe_failed"); }
  if (response?.status !== 405 || response?.redirected === true || response?.headers?.get("allow") !== "GET") throw new Error("ops_mutation_denial_unproven");
  if (response.url) {
    let responseUrl;
    try { responseUrl = new URL(response.url); } catch { throw new Error("ops_mutation_denial_unproven"); }
    if (responseUrl.origin !== target.origin) throw new Error("ops_mutation_denial_unproven");
  }
  return { environment: "development", status: 405, allow: "GET" };
}

async function probeVercel(policy, env, commandRunner, fetchImpl) {
  const token = env.VERCEL_TOKEN;
  const teamId = env.VERCEL_TEAM_ID;
  const projectId = env.VERCEL_PROJECT_ID;
  if (!token || !teamId || !projectId || !policy.capabilities.vercel.project_ids.includes(projectId)) throw new Error("vercel_active_identity_missing");
  const headers = { authorization: `Bearer ${token}` };
  const commandOptions = { env: { PATH: env.PATH ?? process.env.PATH, VERCEL_TOKEN: token, VERCEL_ORG_ID: teamId, VERCEL_PROJECT_ID: projectId } };
  const [user, teamsResponse, project, tokensResponse, environment, deployments] = await Promise.all([
    safeGetJson(fetchImpl, "https://api.vercel.com/v2/user", headers),
    safeGetJson(fetchImpl, "https://api.vercel.com/v2/teams?limit=100", headers),
    safeGetJson(fetchImpl, `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}?teamId=${encodeURIComponent(teamId)}`, headers),
    safeGetJson(fetchImpl, "https://api.vercel.com/v6/user/tokens", headers),
    runJsonCommand(commandRunner, "vercel", ["env", "ls", "production", "--json"], commandOptions),
    runJsonCommand(commandRunner, "vercel", ["ls", "--json", "--environment", "production"], commandOptions),
  ]);
  const team = (teamsResponse.teams ?? []).find((item) => item.id === teamId);
  if (!team) throw new Error("vercel_team_membership_missing");
  const deploymentList = Array.isArray(deployments) ? deployments : deployments.deployments ?? [];
  const target = deploymentList[0]?.url ?? deploymentList[0]?.uid ?? deploymentList[0]?.id;
  if (!target || !/^[A-Za-z0-9_.-]+$/.test(target)) throw new Error("vercel_deployment_missing");
  await runReadCommand(commandRunner, "vercel", ["logs", target, "--json", "--since", "1h"], commandOptions);
  const userId = user.user?.id ?? user.id;
  if (typeof userId !== "string" || !userId) throw new Error("vercel_user_schema_invalid");
  // The official members endpoint is the sole direct-membership authority. The
  // project detail's embedded members field can be partial and is never used.
  const projectMembers = await getProjectMemberPages({
    fetchImpl, headers,
    url: `https://api.vercel.com/v1/projects/${encodeURIComponent(projectId)}/members?teamId=${encodeURIComponent(teamId)}`,
  });
  const accessGroups = await getAccessGroupListPages({
    fetchImpl, headers,
    url: `https://api.vercel.com/v1/access-groups?teamId=${encodeURIComponent(teamId)}`,
  });
  const accessGroupProjects = [];
  const accessGroupMemberships = [];
  for (const group of accessGroups) {
    const groupId = group.accessGroupId ?? group.access_group_id ?? group.id ?? group.uid;
    if (!groupId || !/^[A-Za-z0-9_-]+$/.test(groupId)) throw new Error("vercel_access_groups_unverifiable");
    const members = await getAccessGroupMemberPages({ fetchImpl, headers, url: `https://api.vercel.com/v1/access-groups/${encodeURIComponent(groupId)}/members?teamId=${encodeURIComponent(teamId)}` });
    const currentMemberships = members.filter((member) => [member.uid, member.userId, member.id, member.user?.id].includes(userId));
    if (!currentMemberships.length) continue;
    accessGroupMemberships.push(...currentMemberships.map((member) => ({ ...member, accessGroupId: member.accessGroupId ?? member.access_group_id ?? groupId })));
    const projects = await getAccessGroupProjectPages({ fetchImpl, headers, url: `https://api.vercel.com/v1/access-groups/${encodeURIComponent(groupId)}/projects?teamId=${encodeURIComponent(teamId)}` });
    accessGroupProjects.push(...projects.map((item) => ({ ...item, accessGroupId: item.accessGroupId ?? item.access_group_id ?? groupId })));
  }
  const tokenMetadata = selectActiveVercelToken(tokensResponse, token);
  const normalized = normalizeVercelAccess({ projectId, userId, token: tokenMetadata, team, project, projectMembers, accessGroups, accessGroupProjects, accessGroupMemberships, extendedPermissionsComplete: true });
  return {
    state: "authenticated",
    identity_kind: `${String(normalized.project_role ?? "unknown").toLowerCase()}_team_identity`,
    ...normalized,
    environment_metadata: Array.isArray(environment) || Array.isArray(environment.envs) || Array.isArray(environment.environments),
    decrypted_environment_values: false,
    deployments: true,
    logs: true,
  };
}

async function probeOps(policy, env, commandRunner, fetchImpl, cwd) {
  const token = env.OPS_READ_TOKEN;
  if (!token || !env.HARNESS_ARENA_URL) throw new Error("ops_active_identity_missing");
  const target = resolveOpsTarget(policy, { url: env.HARNESS_ARENA_URL, projectId: env.VERCEL_PROJECT_ID });
  if (target.environment !== "development") throw new Error("ops_mutation_probe_development_only");
  const health = await fetchOpsJson(fetchImpl, `${target.origin}/api/health`, { origin: target.origin });
  if (!validHealth(health)) throw new Error("ops_health_schema_invalid");
  const root = await fetchOpsJson(fetchImpl, `${target.origin}/api/ops/v1`, { origin: target.origin, token });
  if (!validRoot(root)) throw new Error("ops_root_schema_invalid");
  const kind = root.kinds.map((item) => typeof item === "string" ? item : item?.kind).find((item) => /^[a-z][a-z0-9_]*$/.test(item ?? ""));
  const inventoryPath = `${root.inventory}?kind=${encodeURIComponent(kind)}&limit=1`;
  const inventory = await fetchOpsJson(fetchImpl, `${target.origin}${inventoryPath}`, { origin: target.origin, token });
  if (!validInventory(inventory, kind)) throw new Error("ops_inventory_schema_invalid");
  const summary = await fetchOpsJson(fetchImpl, `${target.origin}${root.summary}`, { origin: target.origin, token });
  if (!validSummary(summary)) throw new Error("ops_summary_schema_invalid");
  const mutation_route_coverage = await deriveOpsMutationRouteCoverage({ cwd });
  if (!mutation_route_coverage.complete) throw new Error("ops_mutation_route_coverage_unproven");
  const deployed_source = await deployedOpsSourceIdentity({ commandRunner, fetchImpl, env, target, cwd });
  const mutation_denial = await probeOpsMutationDenial(fetchImpl, target, token);
  return {
    state: "authenticated",
    token_present: true,
    methods: ["GET"],
    get_probes: { "/api/health": 200, "/api/ops/v1": 200, [inventoryPath]: 200, [root.summary]: 200 },
    credential_separation_attested: true,
    target: { environment: target.environment, project_id: target.project_id, hostname: target.hostname },
    mutation_route_coverage,
    deployed_source,
    mutation_denial,
  };
}

export async function collectActiveAccessEvidence({ policy, role, cwd, env = process.env, commandRunner = spawnCommand, fetchImpl = fetch, now = new Date().toISOString() }) {
  const guarded = async (probe, missing) => { try { return await probe(); } catch (error) { return { ...missing, reason: error instanceof Error ? error.message : "probe_failed" }; } };
  const localSeparation = credentialSeparationAttestation(env);
  if (localSeparation.state !== "ok") {
    const missing = { state: "missing", reason: "credential_separation_invalid" };
    return {
      schema_version: "agent_access_evidence.v1", role, captured_at: now,
      github: missing, vercel: missing, ops: { ...missing, token_present: false, methods: [], credential_collisions: ["local"] },
      blob: { credential_present: false, read_via: null }, sandbox: { credential_present: false, read_via: null },
      ai_gateway: { spend_credential_present: false, read_via: null },
      secrets: { forbidden_static_values_present: true, metadata_readable: false, secret_values_accessed: false },
    };
  }
  const [github, vercel, ops] = await Promise.all([
    guarded(() => probeGitHub(policy, env, commandRunner), { state: "missing" }),
    guarded(() => probeVercel(policy, env, commandRunner, fetchImpl), { state: "missing" }),
    guarded(() => probeOps(policy, env, commandRunner, fetchImpl, cwd), { state: "missing", token_present: Boolean(env.OPS_READ_TOKEN), methods: [] }),
  ]);
  const opsObservable = ops.state === "authenticated" && Object.values(ops.get_probes ?? {}).every((status) => status === 200);
  const vercelObservable = vercel.state === "authenticated" && vercel.logs;
  const forbiddenStatic = ["BLOB_READ_WRITE_TOKEN", "AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY", "COMPETITION_ADMIN_TOKEN", "RUNNER_CALLBACK_SECRET", "OPS_READ_CURSOR_SECRET"]
    .some((name) => typeof env[name] === "string" && env[name].length > 0);
  return {
    schema_version: "agent_access_evidence.v1",
    role,
    captured_at: now,
    github,
    vercel,
    ops,
    blob: { credential_present: Boolean(env.BLOB_READ_WRITE_TOKEN), read_via: opsObservable ? "get_only_ops" : null },
    sandbox: { credential_present: vercel.state === "authenticated" && VERCEL_WRITE_ROLES.has(vercel.project_role), read_via: opsObservable ? "get_only_ops" : null },
    ai_gateway: { spend_credential_present: Boolean(env.AI_GATEWAY_API_KEY || env.OPENROUTER_API_KEY), read_via: vercelObservable ? "vercel_logs" : null },
    secrets: { forbidden_static_values_present: forbiddenStatic, metadata_readable: vercel.environment_metadata === true, secret_values_accessed: false },
  };
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
  let evidencePath, role, json = false;
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  for (let index = 0; index < normalized.length; index += 1) {
    const arg = normalized[index];
    if (arg === "--offline-evidence") evidencePath = normalized[++index];
    else if (arg === "--role") role = normalized[++index];
    else if (arg === "--evidence") throw new Error("evidence_mode_must_be_explicitly_offline");
    else if (arg === "--json") json = true;
    else throw new Error("usage: pnpm ops:access-audit -- [--role monitor|diagnostic] [--json] [--offline-evidence <metadata.json>]");
  }
  if (evidencePath?.startsWith("-") || role?.startsWith("-")) throw new Error("invalid_access_audit_argument");
  return { evidencePath, role, json };
}

export async function executeCli(argv, { cwd = process.cwd(), writeOut = (value) => process.stdout.write(`${value}\n`), writeErr = (value) => process.stderr.write(`${value}\n`), evidenceOverride, collector = collectActiveAccessEvidence, commandRunner = spawnCommand, fetchImpl = fetch, env = process.env, now = new Date().toISOString() } = {}) {
  try {
    const args = parseArgs(argv);
    const policy = await loadPolicy(resolve(cwd, "config/agent-access-policy.json"));
    const offlineEvidence = args.evidencePath
      ? evidenceOverride ?? await readBoundedJson(resolve(cwd, args.evidencePath), "agent_access_evidence.v1")
      : null;
    const role = args.role ?? offlineEvidence?.role ?? policy.default_role;
    if (!policy.roles[role]) throw new Error("invalid_access_role");
    const inventory = await auditEnvironmentInventory({ cwd, policy });
    const authority = args.evidencePath ? "offline" : "authoritative";
    const evidence = offlineEvidence ?? await collector({ policy, role, cwd, env, commandRunner, fetchImpl, now });
    if (evidence.role !== role) throw new Error("access_evidence_role_mismatch");
    let report = auditAccessEvidence(policy, evidence, { now, authority });
    if (inventory.missing.length || inventory.unapproved_dynamic.length) report = { ...report, overall: "missing", exit_code: ACCESS_AUDIT_EXIT_CODES.missing };
    const output = redactOpsValue({ ...report, environment_inventory: inventory });
    writeOut(args.json ? JSON.stringify(output) : `${output.overall}: ${output.systems.map((item) => `${item.name}=${item.state}`).join(" ")}`);
    return report.exit_code;
  } catch (error) {
    const allowed = new Set(["invalid_json", "json_file_unavailable", "unsafe_json_file", "unsupported_schema_version", "evidence_mode_must_be_explicitly_offline", "invalid_access_role", "access_evidence_role_mismatch", "invalid_access_audit_argument"]);
    const message = error instanceof Error && allowed.has(error.message) ? error.message : "access_audit_failed";
    writeErr(redactOpsText(message));
    return ACCESS_AUDIT_EXIT_CODES.usage_error;
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exitCode = await executeCli(process.argv.slice(2));
