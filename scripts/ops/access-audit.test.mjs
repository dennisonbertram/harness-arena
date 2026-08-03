import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

const routeModules = import.meta.glob("../../app/api/**/route.ts");

const repo = process.cwd();
const fixture = (name) => join(repo, "scripts", "ops", "fixtures", "access", `${name}.json`);
const policyPath = join(repo, "config", "agent-access-policy.json");

async function subject() { return import("./access-audit.mjs"); }
async function evidence(name) { return JSON.parse(await readFile(fixture(name), "utf8")); }

describe("least-privilege access policy", () => {
  it("derives every source-referenced environment variable and fails on a new unmapped one", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const inventory = await audit.auditEnvironmentInventory({ cwd: repo, policy });
    expect(inventory).toMatchObject({ missing: [], unapproved_dynamic: [] });
    expect(inventory.referenced).toContain("VERCEL_TEAM_ID");
    expect(inventory.referenced).toContain("HARNESS_ARENA_URL");
    expect(inventory.files).toContain("mcp/src/index.ts");
    expect(audit.compareEnvironmentInventory(new Set(["OPS_READ_TOKEN", "NEW_UNMAPPED_ENV"]), policy)).toEqual(["NEW_UNMAPPED_ENV"]);
    expect(audit.deriveEnvironmentReferencesFromText("process.env.DIRECT; process.env['BRACKET']; const { DESTRUCTURED: alias } = process.env").names).toEqual(new Set(["BRACKET", "DESTRUCTURED", "DIRECT"]));
    expect(() => audit.validatePolicy({ ...policy, environment_inventory: { ...policy.environment_inventory, variables: { BAD: { secret: false } } } })).toThrow(/inventory/i);
    expect(JSON.parse(await readFile(join(repo, "config", "agent-access-policy.schema.json"), "utf8")).$id).toContain("agent-access-policy.v1");
  });

  it.each([
    ["viewer", "missing", 2],
    ["app-only", "missing", 2],
    ["missing", "missing", 2],
    ["expired", "missing", 2],
    ["owner", "overprivileged", 3],
  ])("classifies the offline %s fixture as %s", async (name, state, exitCode) => {
    const audit = await subject();
    const report = audit.auditAccessEvidence(await audit.loadPolicy(policyPath), await evidence(name), { now: "2026-08-03T10:00:00.000Z", authority: "offline" });
    expect(report.overall).toBe(state);
    expect(report.exit_code).toBe(exitCode);
    if (name === "owner") {
      for (const system of ["github", "vercel", "blob", "sandbox", "ai_gateway", "secrets"]) {
        expect(report.systems.find((item) => item.name === system)?.state).toBe("overprivileged");
      }
    }
  });

  it("only authoritative active probes can produce observable proof", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const report = audit.auditAccessEvidence(policy, await evidence("viewer"), { now: "2026-08-03T10:00:00.000Z", authority: "authoritative" });
    expect(report).toMatchObject({ overall: "observable", authority: "authoritative", exit_code: 0 });
    const writeOut = vi.fn();
    const collector = vi.fn(async () => await evidence("viewer"));
    expect(await audit.executeCli(["--role", "diagnostic", "--json"], { cwd: repo, writeOut, collector, now: "2026-08-03T10:00:00.000Z" })).toBe(0);
    expect(collector).toHaveBeenCalledOnce();
    expect(JSON.parse(writeOut.mock.calls[0][0])).toMatchObject({ authority: "authoritative", overall: "observable" });
  });

  it("collects authoritative evidence with read-only GitHub, Vercel, and app probes", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const commands = [];
    const commandRunner = vi.fn(async (binary, args) => {
      commands.push([binary, ...args]);
      if (binary === "gh" && args[1] === "user") return { exitCode: 0, stdout: JSON.stringify({ login: "monitor-bot" }) };
      if (binary === "gh" && args[1]?.startsWith("repos/") && args[1].split("/").length === 3) return { exitCode: 0, stdout: JSON.stringify({ permissions: { pull: true, push: false, admin: false } }) };
      if (binary === "gh") return { exitCode: 0, stdout: "[]" };
      if (binary === "vercel" && args[0] === "env") return { exitCode: 0, stdout: JSON.stringify({ envs: [] }) };
      if (binary === "vercel" && args[0] === "ls") return { exitCode: 0, stdout: JSON.stringify({ deployments: [{ url: "monitor-deployment.vercel.app" }] }) };
      if (binary === "vercel" && args[0] === "logs") return { exitCode: 0, stdout: '{"level":"info"}\n' };
      throw new Error("unexpected command");
    });
    const requests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      requests.push([String(url), init?.method]);
      const policySize = policy.capabilities.get_only_ops.separate_from.length;
      const body = String(url).endsWith("/api/health") ? { ok: true, credential_separation: { schema_version: "credential_separation.v1", state: "ok", checked_count: 3, policy_size: policySize } }
        : String(url).endsWith("/api/ops/v1") ? { schema_version: "ops.v1", credential_separation: { schema_version: "credential_separation.v1", state: "ok", checked_count: 3, policy_size: policySize }, kinds: [{ kind: "runs", prefix: "runs/", format: "json" }], inventory: "/api/ops/v1/inventory", summary: "/api/ops/v1/summary" }
          : String(url).includes("/api/ops/v1/inventory?kind=runs&limit=1") ? { schema_version: "ops.v1", kind: "runs", items: [], has_more: false, next_cursor: null }
            : String(url).endsWith("/api/ops/v1/summary") ? { schema_version: "ops.v1", counts: {}, latest: {}, run_states: {}, integrity: {}, scan: { records: 0, complete: true, truncated: false } }
              : String(url).includes("/v2/user") ? { id: "viewer-user" }
        : String(url).includes("/v2/teams?") ? { teams: [{ id: "team-one", membership: { role: "VIEWER", teamRoles: ["VIEWER"], teamPermissions: [] } }] }
          : String(url).includes("/v9/projects/") ? { id: policy.capabilities.vercel.project_ids[0], members: [] }
            : String(url).includes("/v6/user/tokens") ? { tokens: [{ prefix: "viewer-", suffix: "token", scopes: [{ type: "team", teamId: "team-one" }] }] }
              : String(url).includes(`/v1/projects/${policy.capabilities.vercel.project_ids[0]}/members?`) ? String(url).includes("since=123")
                ? { members: [], pagination: { hasNext: false, count: 0, next: null, prev: 123 } }
                : { members: [], pagination: { hasNext: true, count: 0, next: 123, prev: null } }
                : String(url).includes("/v1/access-groups?") ? { accessGroups: [], pagination: { count: 0, next: null } }
            : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    });
    const env = {
      OPS_READ_TOKEN: "read-token",
      GH_TOKEN: "github-read-token",
      VERCEL_TOKEN: "viewer-token",
      VERCEL_TEAM_ID: "team-one",
      VERCEL_PROJECT_ID: policy.capabilities.vercel.project_ids[0],
      HARNESS_ARENA_URL: "https://harness-arena-psi.vercel.app",
    };
    const collected = await audit.collectActiveAccessEvidence({ policy, role: "monitor", cwd: repo, env, commandRunner, fetchImpl, now: "2026-08-03T10:00:00.000Z" });
    const report = audit.auditAccessEvidence(policy, collected, { authority: "authoritative", now: "2026-08-03T10:00:00.000Z" });
    expect(report.overall, JSON.stringify({ collected, report, requests })).toBe("missing");
    expect(report.systems.find(({ name }) => name === "github")).toMatchObject({ state: "missing" });
    expect(commands.every(([binary, action]) => (binary === "gh" && action === "api") || (binary === "vercel" && ["env", "ls", "logs"].includes(action)))).toBe(true);
    expect(requests.every(([, method]) => method === "GET")).toBe(true);
    expect(requests.some(([url]) => url.includes("since=123"))).toBe(true);
  });

  it("never manufactures fine-grained GitHub permissions from successful user GET probes", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const commandRunner = vi.fn(async (_binary, args) => {
      if (args[1] === "user") return { exitCode: 0, stdout: JSON.stringify({ login: "fine-grained-user" }) };
      return { exitCode: 0, stdout: JSON.stringify({ permissions: { pull: true, push: false, admin: false } }) };
    });

    const collected = await audit.collectActiveAccessEvidence({
      policy, role: "monitor", cwd: repo,
      env: { GH_TOKEN: "fine-grained-pat", GH_INSTALLATION_TOKEN_EVIDENCE_FILE: "/does/not/exist" },
      commandRunner, fetchImpl: vi.fn(),
    });

    expect(collected.github).toMatchObject({ identity_kind: "authenticated_user", permissions: {} });
    expect(audit.auditAccessEvidence(policy, collected, { authority: "authoritative" }).systems.find(({ name }) => name === "github"))
      .toMatchObject({ state: "missing" });
  });

  it("fails closed when the official paginated project-members schema is absent, even if project.members is populated", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const commandRunner = vi.fn(async (binary, args) => {
      if (binary === "gh") return { exitCode: 0, stdout: args[1] === "user" ? JSON.stringify({ login: "monitor-bot" }) : "[]" };
      if (binary === "vercel" && args[0] === "env") return { exitCode: 0, stdout: JSON.stringify({ envs: [] }) };
      if (binary === "vercel" && args[0] === "ls") return { exitCode: 0, stdout: JSON.stringify({ deployments: [{ url: "monitor-deployment.vercel.app" }] }) };
      if (binary === "vercel" && args[0] === "logs") return { exitCode: 0, stdout: "{}" };
      throw new Error("unexpected command");
    });
    const requested = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const target = String(url);
      requested.push([target, init?.method]);
      const body = target.includes("/v2/user") ? { id: "viewer-user" }
        : target.includes("/v2/teams?") ? { teams: [{ id: "team-one", membership: { role: "VIEWER", teamRoles: ["VIEWER"], teamPermissions: [] } }] }
          // This legacy embedded field must never substitute for the endpoint below.
          : target.includes("/v9/projects/") ? { id: policy.capabilities.vercel.project_ids[0], members: [{ uid: "viewer-user", role: "PROJECT_VIEWER" }] }
            : target.includes("/v6/user/tokens") ? { tokens: [{ prefix: "viewer-", suffix: "token", scopes: [{ type: "team", teamId: "team-one" }] }] }
              : target.includes("/v1/access-groups?") ? { accessGroups: [], pagination: { count: 0, next: null } }
                // Deliberately malformed: a real members response needs value plus pagination.
                : target.includes(`/v1/projects/${policy.capabilities.vercel.project_ids[0]}/members?`) ? { members: [] }
                  : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    });
    const collected = await audit.collectActiveAccessEvidence({
      policy, role: "monitor", cwd: repo,
      env: { GH_TOKEN: "github-read-token", VERCEL_TOKEN: "viewer-token", VERCEL_TEAM_ID: "team-one", VERCEL_PROJECT_ID: policy.capabilities.vercel.project_ids[0] },
      commandRunner, fetchImpl,
    });
    expect(collected.vercel).toMatchObject({ state: "missing" });
    expect(requested.some(([url]) => url.includes(`/v1/projects/${policy.capabilities.vercel.project_ids[0]}/members?`))).toBe(true);
    expect(requested.every(([, method]) => method === "GET")).toBe(true);
  });

  it("uses Vercel's documented members and access-group schemas without understating effective write access", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const commandRunner = vi.fn(async (binary, args) => {
      if (binary === "gh") return { exitCode: 0, stdout: args[1] === "user" ? JSON.stringify({ login: "monitor-bot" }) : "[]" };
      if (binary === "vercel" && args[0] === "env") return { exitCode: 0, stdout: JSON.stringify({ envs: [] }) };
      if (binary === "vercel" && args[0] === "ls") return { exitCode: 0, stdout: JSON.stringify({ deployments: [{ url: "monitor-deployment.vercel.app" }] }) };
      if (binary === "vercel" && args[0] === "logs") return { exitCode: 0, stdout: "{}" };
      throw new Error("unexpected command");
    });
    const requests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const target = String(url);
      requests.push([target, init?.method]);
      const body = target.includes("/v2/user") ? { id: "viewer-user" }
        : target.includes("/v2/teams?") ? { teams: [{ id: "team-one", membership: { role: "VIEWER", teamRoles: ["VIEWER"], teamPermissions: [] } }] }
          : target.includes("/v9/projects/") ? { id: policy.capabilities.vercel.project_ids[0] }
            : target.includes("/v6/user/tokens") ? { tokens: [{ prefix: "viewer-", suffix: "token", scopes: [{ type: "team", teamId: "team-one" }] }] }
              : target.includes(`/v1/projects/${policy.capabilities.vercel.project_ids[0]}/members?`) ? target.includes("since=123")
                ? { members: [], pagination: { hasNext: false, count: 0, next: null, prev: 123 } }
                : { members: [{ uid: "viewer-user", computedProjectRole: "PROJECT_DEVELOPER" }], pagination: { hasNext: true, count: 1, next: 123, prev: null } }
                : target.includes("/v1/access-groups?") ? target.includes("next=group-page-2")
                  ? { accessGroups: [], pagination: { count: 0, next: null } }
                  : { accessGroups: [{ id: "group-one", teamRoles: ["VIEWER"], teamPermissions: ["FullProductionDeployment"] }], pagination: { count: 1, next: "group-page-2" } }
                  : target.includes("/v1/access-groups/group-one/members?") ? { members: [{ uid: "viewer-user", teamRole: "VIEWER" }], pagination: { count: 1, next: null } }
                    : target.includes("/v1/access-groups/group-one/projects?") ? { projects: [{ projectId: policy.capabilities.vercel.project_ids[0], role: "PROJECT_VIEWER" }], pagination: { count: 1, next: null } }
                      : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    });
    const collected = await audit.collectActiveAccessEvidence({
      policy, role: "monitor", cwd: repo,
      env: { GH_TOKEN: "github-read-token", VERCEL_TOKEN: "viewer-token", VERCEL_TEAM_ID: "team-one", VERCEL_PROJECT_ID: policy.capabilities.vercel.project_ids[0] },
      commandRunner, fetchImpl,
    });
    const vercel = audit.auditAccessEvidence(policy, collected, { authority: "authoritative" }).systems.find(({ name }) => name === "vercel");
    expect(collected.vercel).toMatchObject({ project_role: "DEVELOPER", team_permissions: ["FullProductionDeployment"], extended_permissions_complete: true });
    expect(vercel).toMatchObject({ state: "overprivileged" });
    expect(requests.every(([, method]) => method === "GET")).toBe(true);
    expect(requests.some(([url]) => url.includes(`/v1/projects/${policy.capabilities.vercel.project_ids[0]}/members?`) && url.includes("limit=100") && url.includes("since=123"))).toBe(true);
    expect(requests.some(([url]) => url.includes("/v1/access-groups?") && url.includes("next=group-page-2"))).toBe(true);
  });

  it("treats a project member's singular teamRole as effective privilege even when computedProjectRole is Viewer", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const normalized = audit.normalizeVercelAccess({
      projectId: "project-one",
      userId: "user-one",
      team: { membership: { role: "VIEWER", teamRoles: ["VIEWER"], teamPermissions: [] } },
      projectMembers: [{ uid: "user-one", computedProjectRole: "PROJECT_VIEWER", teamRole: "OWNER" }],
    });
    expect(normalized).toMatchObject({ team_role: "OWNER", project_role: "OWNER", extended_permissions_complete: true });
    const raw = await evidence("viewer");
    raw.vercel = { ...raw.vercel, ...normalized };
    expect(audit.auditAccessEvidence(policy, raw, { authority: "authoritative" }).systems.find(({ name }) => name === "vercel"))
      .toMatchObject({ state: "overprivileged" });
  });

  it("fails closed when access-group page count disagrees with the returned collection", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const commandRunner = vi.fn(async (binary, args) => {
      if (binary === "gh") return { exitCode: 0, stdout: args[1] === "user" ? JSON.stringify({ login: "monitor-bot" }) : "[]" };
      if (binary === "vercel" && args[0] === "env") return { exitCode: 0, stdout: JSON.stringify({ envs: [] }) };
      if (binary === "vercel" && args[0] === "ls") return { exitCode: 0, stdout: JSON.stringify({ deployments: [{ url: "monitor-deployment.vercel.app" }] }) };
      if (binary === "vercel" && args[0] === "logs") return { exitCode: 0, stdout: "{}" };
      throw new Error("unexpected command");
    });
    const fetchImpl = vi.fn(async (url) => {
      const target = String(url);
      const body = target.includes("/v2/user") ? { id: "viewer-user" }
        : target.includes("/v2/teams?") ? { teams: [{ id: "team-one", membership: { role: "VIEWER", teamRoles: ["VIEWER"], teamPermissions: [] } }] }
          : target.includes("/v9/projects/") ? { id: policy.capabilities.vercel.project_ids[0] }
            : target.includes("/v6/user/tokens") ? { tokens: [] }
              : target.includes(`/v1/projects/${policy.capabilities.vercel.project_ids[0]}/members?`) ? { members: [], pagination: { hasNext: false, count: 0, next: null, prev: null } }
                : target.includes("/v1/access-groups?") ? { accessGroups: [], pagination: { count: 1, next: null } }
                  : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    });
    const collected = await audit.collectActiveAccessEvidence({
      policy, role: "monitor", cwd: repo,
      env: { VERCEL_TOKEN: "viewer-token", VERCEL_TEAM_ID: "team-one", VERCEL_PROJECT_ID: policy.capabilities.vercel.project_ids[0] },
      commandRunner, fetchImpl,
    });
    expect(collected.vercel).toMatchObject({ state: "missing" });
  });

  it("directly rejects a repeated Vercel project-member pagination cursor", async () => {
    const audit = await subject();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return { ok: true, text: async () => JSON.stringify({ members: [], pagination: { hasNext: true, count: 0, next: 123, prev: null } }) };
    });

    await expect(audit.getProjectMemberPages({ fetchImpl, headers: {}, url: "https://api.vercel.com/v1/projects/project/members" }))
      .rejects.toThrow("vercel_project_members_pagination_repeated");
    expect(calls).toBe(2);
  });

  it("directly rejects Vercel access-group pagination that exhausts the page cap", async () => {
    const audit = await subject();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return { ok: true, text: async () => JSON.stringify({ accessGroups: [], pagination: { count: 0, next: `cursor-${calls}` } }) };
    });

    await expect(audit.getAccessGroupPages({ fetchImpl, headers: {}, url: "https://api.vercel.com/v1/access-groups", collection: "accessGroups" }))
      .rejects.toThrow("vercel_access_group_pagination_limit_exceeded");
    expect(calls).toBe(100);
  });

  it("never infers a GitHub App installation token's fine-grained permissions from successful GET probes", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const collect = async (repositoryPermissions) => {
      const commandRunner = vi.fn(async (binary, args) => {
        if (binary !== "gh" || args[0] !== "api") throw new Error("unexpected command");
        if (args[1] === "user") return { exitCode: 1, stdout: "" };
        if (args[1] === "installation/repositories") return { exitCode: 0, stdout: JSON.stringify({
          total_count: 1,
          repositories: [{ full_name: policy.capabilities.github.repository, owner: { login: "github-app" }, permissions: repositoryPermissions }],
          repository_selection: "selected",
        }) };
        return { exitCode: 0, stdout: JSON.stringify(args[1] === `repos/${policy.capabilities.github.repository}` ? { permissions: { pull: true, push: false, admin: false } } : []) };
      });
      return await audit.collectActiveAccessEvidence({ policy, role: "monitor", cwd: repo, env: { GH_TOKEN: "installation-token" }, commandRunner, fetchImpl: vi.fn() });
    };
    const readOnlyButUnverifiable = await collect({ pull: true, push: false, admin: false, maintain: false, triage: false });
    expect(audit.auditAccessEvidence(policy, readOnlyButUnverifiable, { authority: "authoritative" }).systems.find(({ name }) => name === "github"))
      .toMatchObject({ state: "missing" });
    const writeCapable = await collect({ pull: true, push: true, admin: false, maintain: false, triage: false });
    expect(audit.auditAccessEvidence(policy, writeCapable, { authority: "authoritative" }).systems.find(({ name }) => name === "github"))
      .toMatchObject({ state: "overprivileged" });
  });

  it("preserves an authoritative GitHub App token issuance permission map without emitting its token", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const directory = await mkdtemp(join(tmpdir(), "github-installation-evidence-"));
    const evidencePath = join(directory, "token-response.json");
    const permissions = { metadata: "read", contents: "read", actions: "read", issues: "read", pull_requests: "read" };
    await writeFile(evidencePath, JSON.stringify({
      token: "installation-token-never-emit",
      expires_at: "2026-09-03T10:00:00.000Z",
      permissions,
      repository_selection: "selected",
      repositories: [{ full_name: policy.capabilities.github.repository }],
    }), { mode: 0o600 });
    try {
      const commandRunner = vi.fn(async (_binary, args) => {
        if (args[1] === "user") return { exitCode: 1, stdout: "" };
        if (args[1] === "installation/repositories") return { exitCode: 0, stdout: JSON.stringify({
          total_count: 1,
          repositories: [{ full_name: policy.capabilities.github.repository, owner: { login: "github-app" }, permissions: { pull: true, push: false, admin: false } }],
          repository_selection: "selected",
        }) };
        return { exitCode: 0, stdout: JSON.stringify(args[1] === `repos/${policy.capabilities.github.repository}` ? { permissions: { pull: true, push: false, admin: false } } : []) };
      });
      const collected = await audit.collectActiveAccessEvidence({
        policy, role: "monitor", cwd: repo,
        env: { GH_TOKEN: "installation-token-never-emit", GH_INSTALLATION_TOKEN_EVIDENCE_FILE: evidencePath },
        commandRunner, fetchImpl: vi.fn(), now: "2026-08-03T10:00:00.000Z",
      });
      expect(collected.github).toMatchObject({ identity_kind: "github_app", permissions, expires_at: "2026-09-03T10:00:00.000Z" });
      expect(audit.auditAccessEvidence(policy, collected, { authority: "authoritative", now: "2026-08-03T10:00:00.000Z" }).systems.find(({ name }) => name === "github"))
        .toMatchObject({ state: "observable" });
      expect(JSON.stringify(collected)).not.toContain("installation-token-never-emit");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["GH_TOKEN", "GITHUB_TOKEN", "VERCEL_TOKEN"])("attests local %s before making any external request", async (collidingName) => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const commandRunner = vi.fn();
    const fetchImpl = vi.fn();
    const secret = "must-never-leave-process";
    const env = {
        OPS_READ_TOKEN: secret,
        GH_TOKEN: "github-read-token",
        VERCEL_TOKEN: "vercel-read-token",
        VERCEL_TEAM_ID: "team-one",
        VERCEL_PROJECT_ID: policy.capabilities.vercel.project_ids[0],
        HARNESS_ARENA_URL: "https://harness-arena-psi.vercel.app",
      };
    env[collidingName] = secret;
    const collected = await audit.collectActiveAccessEvidence({
      policy, role: "monitor", cwd: repo, env,
      commandRunner, fetchImpl,
    });
    expect(commandRunner).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(collected.ops).toMatchObject({ state: "missing", reason: "credential_separation_invalid" });
    expect(JSON.stringify(collected)).not.toContain(secret);
  });

  it("does not use inherited GitHub CLI authentication when explicit GH_TOKEN is unavailable", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const commandRunner = vi.fn(async () => ({ exitCode: 1, stdout: "" }));
    const collected = await audit.collectActiveAccessEvidence({
      policy, role: "monitor", cwd: repo,
      env: {}, commandRunner, fetchImpl: vi.fn(),
    });
    expect(collected.github).toMatchObject({ state: "missing", reason: "github_explicit_identity_missing" });
    expect(commandRunner.mock.calls.some(([binary]) => binary === "gh")).toBe(false);
  });

  it("rejects arbitrary 200 responses instead of treating them as ops.v1 proof", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const env = { OPS_READ_TOKEN: "read-token", VERCEL_PROJECT_ID: policy.capabilities.vercel.project_ids[0], HARNESS_ARENA_URL: "https://harness-arena-psi.vercel.app" };
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, redirected: false, text: async () => JSON.stringify({ ok: true }) }));
    const collected = await audit.collectActiveAccessEvidence({ policy, role: "monitor", cwd: repo, env, commandRunner: vi.fn(async () => ({ exitCode: 1, stdout: "" })), fetchImpl });
    expect(collected.ops.state).toBe("missing");
  });

  it("validates host, TLS, and project binding before sending OPS_READ_TOKEN", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const projectId = policy.capabilities.vercel.project_ids[0];
    expect(audit.resolveOpsTarget(policy, { url: "https://harness-arena-psi.vercel.app", projectId })).toMatchObject({ environment: "production" });
    expect(audit.resolveOpsTarget(policy, { url: "https://harness-arena-development.vercel.app", projectId: policy.capabilities.vercel.project_ids[1] })).toMatchObject({ environment: "development" });
    expect(audit.resolveOpsTarget(policy, { url: "http://127.0.0.1:3000", projectId: undefined })).toMatchObject({ environment: "local" });
    for (const input of [
      { url: "http://harness-arena-psi.vercel.app", projectId },
      { url: "https://harness-arena-psi.vercel.app:444", projectId },
      { url: "https://attacker.example", projectId },
      { url: "https://harness-arena-psi.vercel.app", projectId: policy.capabilities.vercel.project_ids[1] },
      { url: "http://localhost.evil:3000", projectId: undefined },
    ]) expect(() => audit.resolveOpsTarget(policy, input)).toThrow(/target/i);

    const fetchImpl = vi.fn();
    const collected = await audit.collectActiveAccessEvidence({
      policy, role: "monitor", cwd: repo,
      env: { OPS_READ_TOKEN: "never-send-me", VERCEL_PROJECT_ID: projectId, HARNESS_ARENA_URL: "https://attacker.example" },
      commandRunner: vi.fn(async () => ({ exitCode: 1, stdout: "" })), fetchImpl,
    });
    expect(collected.ops.state).toBe("missing");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects redirects before an ops token can follow them", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url: String(url), authorization: init?.headers?.authorization });
      return { ok: true, status: 200, redirected: true, url: "https://attacker.example/api/health", text: async () => "{}" };
    });
    const collected = await audit.collectActiveAccessEvidence({
      policy, role: "monitor", cwd: repo,
      env: { OPS_READ_TOKEN: "never-follow-me", VERCEL_PROJECT_ID: policy.capabilities.get_only_ops.targets.development.project_id, HARNESS_ARENA_URL: "https://harness-arena-development.vercel.app" },
      commandRunner: vi.fn(async () => ({ exitCode: 1, stdout: "" })), fetchImpl,
    });
    expect(collected.ops.state).toBe("missing");
    expect(calls).toEqual([{ url: "https://harness-arena-development.vercel.app/api/health", authorization: undefined }]);
  });

  it("normalizes a project-scoped Vercel token with the inherited Viewer role", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    expect(audit.normalizeVercelAccess({
      projectId: "project-one",
      userId: "user-one",
      token: audit.selectActiveVercelToken({ tokens: [{ prefix: "vcp_", suffix: "tail", scopes: [{ type: "project", projectId: "project-one" }] }] }, "vcp_secret-tail"),
      team: { membership: { role: "VIEWER" } },
      projectMembers: [],
    })).toMatchObject({ token_project_id: "project-one", team_role: "VIEWER", project_role: "VIEWER", role_source: "team_inherited" });
    expect(audit.normalizeVercelAccess({ projectId: "project-one", userId: "user-one", team: { membership: { role: "VIEWER" } }, projectMembers: [{ uid: "user-one", role: "PROJECT_VIEWER" }] }).project_role).toBe("VIEWER");
    expect(audit.normalizeVercelAccess({ projectId: "project-one", userId: "user-one", team: { membership: { role: "VIEWER" } }, projectMembers: [{ uid: "user-one", role: "PROJECT_DEVELOPER" }] }).project_role).toBe("DEVELOPER");
    expect(audit.normalizeVercelAccess({ projectId: "project-one", userId: "user-one", team: { membership: { role: "VIEWER" } }, projectMembers: [{ uid: "user-one", role: "ADMIN" }] }).project_role).toBe("ADMIN");
    expect(audit.normalizeVercelAccess({ projectId: "project-one", userId: "user-one", team: { membership: { role: "VIEWER" } }, projectMembers: [{ uid: "user-one", role: "project-admin" }] }).project_role).toBe("ADMIN");
    expect(audit.normalizeVercelAccess({
      projectId: "project-one",
      userId: "user-one",
      team: { membership: { role: "VIEWER", teamRoles: ["VIEWER"], teamPermissions: [] } },
      projectMembers: [{ uid: "user-one", role: "PROJECT_VIEWER" }, { uid: "user-one", role: "PROJECT_ADMIN" }],
    })).toMatchObject({ project_role: "ADMIN", extended_permissions_complete: true });
    expect(audit.normalizeVercelAccess({
      projectId: "project-one", userId: "user-one",
      team: { membership: { role: "VIEWER", teamRoles: ["VIEWER"], teamPermissions: [] } },
      projectMembers: [],
      accessGroupMemberships: [{ uid: "user-one", accessGroupId: "group-one", teamRoles: ["VIEWER"], permissions: ["OrgViewer"] }],
      accessGroupProjects: [{ accessGroupId: "group-one", projectId: "project-one", role: "PROJECT_VIEWER" }, { accessGroupId: "group-one", projectId: "project-one", role: "ADMIN" }],
    })).toMatchObject({ project_role: "ADMIN", role_source: "access_group_effective", extended_permissions_complete: true });
    for (const role of ["PROJECT_DEVELOPER", "ADMIN", "project-admin"]) {
      const raw = await evidence("viewer");
      raw.vercel.project_role = role;
      expect(audit.auditAccessEvidence(policy, raw, { authority: "authoritative", now: "2026-08-03T10:00:00.000Z" }).systems.find(({ name }) => name === "vercel")?.state, role).toBe("overprivileged");
    }
    for (const permission of ["CreateProject", "FullProductionDeployment", "OrgAdmin", "EnvironmentManager"]) {
      const raw = await evidence("viewer");
      raw.vercel.team_permissions = [permission];
      raw.vercel.extended_permissions_complete = true;
      expect(audit.auditAccessEvidence(policy, raw, { authority: "authoritative", now: "2026-08-03T10:00:00.000Z" }).systems.find(({ name }) => name === "vercel"), permission)
        .toMatchObject({ state: "overprivileged" });
    }
    const unverifiable = await evidence("viewer");
    unverifiable.vercel.extended_permissions_complete = false;
    expect(audit.auditAccessEvidence(policy, unverifiable, { authority: "authoritative", now: "2026-08-03T10:00:00.000Z" }).systems.find(({ name }) => name === "vercel"))
      .toMatchObject({ state: "missing", reasons: ["vercel_extended_permissions_unverifiable"] });
  });

  it("derives every runtime credential-separation class from one central policy", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const separation = await import("../../lib/credential-separation.mjs");
    expect(policy.capabilities.get_only_ops.separate_from).toEqual(separation.OPS_READ_SEPARATE_FROM);
    for (const name of separation.OPS_READ_SEPARATE_FROM) {
      const attestation = separation.credentialSeparationAttestation({ OPS_READ_TOKEN: "collision", [name]: "collision" });
      expect(attestation, name).toMatchObject({ schema_version: "credential_separation.v1", state: "invalid", checked_count: 1 });
      expect(JSON.stringify(attestation)).not.toContain("collision");
      expect(() => separation.assertOpsReadCredentialSeparation({ OPS_READ_TOKEN: "collision", [name]: "collision" }), name).toThrow("credential_separation_invalid");
    }
    vi.stubEnv("OPS_READ_TOKEN", "attested-read-token");
    const loader = routeModules["../../app/api/ops/v1/route.ts"];
    const { GET } = await loader();
    const response = await GET(new Request("http://localhost/api/ops/v1", { headers: { authorization: "Bearer attested-read-token" } }));
    expect(await response.json()).toMatchObject({ credential_separation: { schema_version: "credential_separation.v1", state: "ok", policy_size: separation.OPS_READ_SEPARATE_FROM.length } });
    vi.unstubAllEnvs();
  });

  it("fails closed when AUTH_SECRET collides with OPS_READ_TOKEN", async () => {
    vi.stubEnv("OPS_READ_TOKEN", "auth-collision");
    vi.stubEnv("AUTH_SECRET", "auth-collision");
    const { mintAgentToken } = await import("../../lib/agent-token");
    await expect(mintAgentToken({ githubId: 1, githubLogin: "agent" })).rejects.toThrow(/credential_separation_invalid/);
    vi.unstubAllEnvs();
  });

  it("enforces role-specific secret value access", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const monitor = await evidence("app-only");
    monitor.secrets = { forbidden_static_values_present: false, metadata_readable: true, secret_values_accessed: false };
    expect(audit.auditAccessEvidence(policy, monitor, { authority: "authoritative", now: "2026-08-03T10:00:00.000Z" }).overall).toBe("observable");
    monitor.secrets.secret_values_accessed = true;
    monitor.secrets.ephemeral_file_mode = "0600";
    monitor.secrets.cleanup_verified = true;
    expect(audit.auditAccessEvidence(policy, monitor, { authority: "authoritative", now: "2026-08-03T10:00:00.000Z" }).systems.find(({ name }) => name === "secrets")?.state).toBe("overprivileged");
    const diagnostic = await evidence("viewer");
    diagnostic.secrets = { forbidden_static_values_present: false, metadata_readable: true, secret_values_accessed: true };
    expect(audit.auditAccessEvidence(policy, diagnostic, { authority: "authoritative", now: "2026-08-03T10:00:00.000Z" }).systems.find(({ name }) => name === "secrets")?.state).toBe("missing");
    diagnostic.secrets.ephemeral_file_mode = "0600";
    diagnostic.secrets.cleanup_verified = true;
    expect(audit.auditAccessEvidence(policy, diagnostic, { authority: "authoritative", now: "2026-08-03T10:00:00.000Z" }).systems.find(({ name }) => name === "secrets")?.state).toBe("observable");
  });

  it("rejects an empty methods list as no GET proof", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const raw = await evidence("viewer");
    raw.ops.methods = [];
    expect(audit.auditAccessEvidence(policy, raw, { authority: "authoritative", now: "2026-08-03T10:00:00.000Z" }).systems.find(({ name }) => name === "get_only_ops")?.state).toBe("missing");
  });

  it("requires complete static ops mutation coverage and a Development-only live denial", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const coverage = await audit.deriveOpsMutationRouteCoverage({ cwd: repo });
    expect(coverage).toMatchObject({ complete: true, routes: expect.arrayContaining([
      expect.objectContaining({ pathname: "/api/ops/v1", handlers: [
        { method: "POST", source: "POST", canonical_denial: true },
        { method: "PUT", source: "PUT", canonical_denial: true },
        { method: "PATCH", source: "PATCH", canonical_denial: true },
        { method: "DELETE", source: "DELETE", canonical_denial: true },
      ] }),
    ]) });
    const { methodNotAllowed } = await import("../../lib/ops-route");
    for (const route of coverage.routes) {
      const loader = routeModules[`../../${route.file}`];
      expect(loader, route.file).toBeTypeOf("function");
      const routeModule = await loader();
      for (const handler of route.handlers) {
        expect(routeModule[handler.method], `${route.pathname} ${handler.method}`).toBe(methodNotAllowed);
        const response = await routeModule[handler.method](new Request(`http://localhost${route.pathname}`, { method: handler.method }));
        expect(response.status, `${route.pathname} ${handler.method}`).toBe(405);
        expect(response.headers.get("allow"), `${route.pathname} ${handler.method}`).toBe("GET");
      }
    }

    const raw = await evidence("viewer");
    raw.ops.mutation_route_coverage = coverage;
    raw.ops.target = { environment: "development", project_id: policy.capabilities.get_only_ops.targets.development.project_id, hostname: "harness-arena-development.vercel.app" };
    raw.ops.deployed_source = {
      deployment_id: "dpl_development",
      deployment_url: "harness-arena-development-git-dev-unique.vercel.app",
      project_id: policy.capabilities.get_only_ops.targets.development.project_id,
      sha: "a".repeat(40), source_sha: "a".repeat(40), hostname: "harness-arena-development.vercel.app",
    };
    raw.ops.mutation_denial = { environment: "development", status: 405, allow: "GET" };
    expect(audit.auditAccessEvidence(policy, raw, { authority: "authoritative" }).systems.find(({ name }) => name === "get_only_ops"))
      .toMatchObject({ state: "observable" });

    raw.ops.target.environment = "production";
    expect(audit.auditAccessEvidence(policy, raw, { authority: "authoritative" }).systems.find(({ name }) => name === "get_only_ops"))
      .toMatchObject({ state: "missing", reasons: ["ops_development_mutation_denial_unproven"] });
  });

  it("derives ops mutation safety from canonical exports, including aliases and GET-only routes", async () => {
    const audit = await subject();
    const directory = await mkdtemp(join(tmpdir(), "ops-route-coverage-"));
    try {
      await mkdir(join(directory, "app/api/ops/v1/get-only"), { recursive: true });
      await mkdir(join(directory, "app/api/ops/v1/aliased"), { recursive: true });
      await mkdir(join(directory, "app/api/ops/v1/custom"), { recursive: true });
      await mkdir(join(directory, "lib"), { recursive: true });
      await writeFile(join(directory, "lib/ops-route.ts"), "export const methodNotAllowed = () => new Response(null, { status: 405 });\nexport const POST=methodNotAllowed,PUT=methodNotAllowed,PATCH=methodNotAllowed,DELETE=methodNotAllowed;\n");
      await writeFile(join(directory, "app/api/ops/v1/get-only/route.ts"), "export async function GET() { return new Response('ok'); }\n");
      await writeFile(join(directory, "app/api/ops/v1/aliased/route.ts"), "export { methodNotAllowed as POST, DELETE as PATCH } from '@/lib/ops-route';\n");
      await writeFile(join(directory, "app/api/ops/v1/custom/route.ts"), "export const PUT = () => new Response('write');\n");

      const coverage = await audit.deriveOpsMutationRouteCoverage({ cwd: directory });
      expect(coverage.routes.find(({ pathname }) => pathname.endsWith("/get-only"))).toMatchObject({ handlers: [], complete: true });
      expect(coverage.routes.find(({ pathname }) => pathname.endsWith("/aliased"))).toMatchObject({
        handlers: [
          { method: "POST", source: "methodNotAllowed", canonical_denial: true },
          { method: "PATCH", source: "DELETE", canonical_denial: true },
        ],
        complete: true,
      });
      expect(coverage.routes.find(({ pathname }) => pathname.endsWith("/custom"))).toMatchObject({
        handlers: [{ method: "PUT", source: "PUT", canonical_denial: false }],
        complete: false,
      });
      expect(coverage.complete).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("sends the live mutation denial probe only to the isolated Development target", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const calls = [];
    const policySize = policy.capabilities.get_only_ops.separate_from.length;
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push([String(url), init?.method, init?.headers?.authorization]);
      const address = String(url);
      const body = address.includes("/v13/deployments/dpl_development") ? {
        id: "dpl_development",
        url: "harness-arena-development-git-dev-unique.vercel.app",
        alias: ["harness-arena-development.vercel.app"],
        projectId: policy.capabilities.get_only_ops.targets.development.project_id,
        gitSource: { type: "github", sha: "a".repeat(40), ref: "dev" },
      }
        : address.endsWith("/api/health") ? { ok: true, credential_separation: { schema_version: "credential_separation.v1", state: "ok", checked_count: 0, policy_size: policySize } }
        : address.endsWith("/api/ops/v1") && init?.method === "GET" ? { schema_version: "ops.v1", credential_separation: { schema_version: "credential_separation.v1", state: "ok", checked_count: 0, policy_size: policySize }, kinds: ["runs"], inventory: "/api/ops/v1/inventory", summary: "/api/ops/v1/summary" }
          : address.includes("/inventory?") ? { schema_version: "ops.v1", kind: "runs", items: [], has_more: false, next_cursor: null }
            : address.endsWith("/summary") ? { schema_version: "ops.v1", counts: {}, latest: {}, run_states: {}, integrity: {}, scan: {} }
              : null;
      if (address.endsWith("/api/ops/v1") && init?.method === "POST") return { ok: false, status: 405, headers: new Headers({ allow: "GET" }), redirected: false, text: async () => "" };
      return { ok: true, status: 200, redirected: false, text: async () => JSON.stringify(body) };
    });

    const collected = await audit.collectActiveAccessEvidence({
      policy, role: "monitor", cwd: repo,
      env: { OPS_READ_TOKEN: "development-read-token", VERCEL_TOKEN: "development-vercel-viewer", VERCEL_TEAM_ID: "team-development", VERCEL_PROJECT_ID: policy.capabilities.get_only_ops.targets.development.project_id, HARNESS_ARENA_URL: "https://harness-arena-development.vercel.app" },
      commandRunner: vi.fn(async (binary, args) => {
        if (binary === "vercel" && args[0] === "inspect") return { exitCode: 0, stdout: JSON.stringify({
          id: "dpl_development",
          url: "harness-arena-development-git-dev-unique.vercel.app",
          aliases: ["harness-arena-development.vercel.app"],
        }) };
        if (binary === "git" && args[0] === "rev-parse") return { exitCode: 0, stdout: `${"a".repeat(40)}\n` };
        return { exitCode: 1, stdout: "" };
      }), fetchImpl,
    });

    expect(collected.ops.mutation_denial).toMatchObject({ environment: "development", status: 405, allow: "GET" });
    expect(collected.ops.deployed_source).toMatchObject({
      deployment_id: "dpl_development",
      deployment_url: "harness-arena-development-git-dev-unique.vercel.app",
      project_id: policy.capabilities.get_only_ops.targets.development.project_id,
      hostname: "harness-arena-development.vercel.app",
      sha: "a".repeat(40),
      source_sha: "a".repeat(40),
    });
    expect(calls.some(([url, method]) => url.includes("/v13/deployments/dpl_development") && url.includes("withGitRepoInfo=true") && method === "GET")).toBe(true);
    expect(calls.filter(([, method]) => method === "POST")).toEqual([["https://harness-arena-development.vercel.app/api/ops/v1", "POST", "Bearer development-read-token"]]);
  });

  it("never sends a mutation denial probe to Production", async () => {
    const audit = await subject();
    const policy = await audit.loadPolicy(policyPath);
    const fetchImpl = vi.fn();
    const collected = await audit.collectActiveAccessEvidence({
      policy, role: "monitor", cwd: repo,
      env: { OPS_READ_TOKEN: "production-read-token", VERCEL_PROJECT_ID: policy.capabilities.get_only_ops.targets.production.project_id, HARNESS_ARENA_URL: "https://harness-arena-psi.vercel.app" },
      commandRunner: vi.fn(), fetchImpl,
    });

    expect(collected.ops).toMatchObject({ state: "missing", reason: "ops_mutation_probe_development_only" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses a 0600 ephemeral secret file, redacts output, and cleans up on success", async () => {
    const audit = await subject();
    let secretPath;
    const result = await audit.withEphemeralSecretFile({
      secret: "secret-success-sentinel",
      run: async (path) => {
        secretPath = path;
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(await readFile(path, "utf8")).toBe("secret-success-sentinel");
        return { stdout: "token=secret-success-sentinel", stderr: "Bearer secret-success-sentinel" };
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-success-sentinel");
    await expect(access(secretPath, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts thrown errors and cleans up the ephemeral file on error", async () => {
    const audit = await subject();
    let secretPath;
    const error = await audit.withEphemeralSecretFile({
      secret: "secret-error-sentinel",
      run: async (path) => { secretPath = path; throw new Error("failed with secret-error-sentinel"); },
    }).catch((caught) => caught);
    expect(String(error?.message)).not.toContain("secret-error-sentinel");
    await expect(access(secretPath, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up and rejects when interrupted", async () => {
    const audit = await subject();
    const signals = new EventEmitter();
    let secretPath;
    const running = audit.withEphemeralSecretFile({
      secret: "secret-signal-sentinel",
      signalSource: signals,
      run: async (path) => { secretPath = path; return new Promise(() => {}); },
    });
    while (!secretPath) await new Promise((resolve) => setTimeout(resolve, 1));
    signals.emit("SIGTERM");
    await expect(running).rejects.toThrow(/interrupted/i);
    await expect(access(secretPath, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps ephemeral secret directories ignored", async () => {
    expect(await readFile(join(repo, ".gitignore"), "utf8")).toMatch(/^\.agent-access-secrets\/$/m);
  });

  it("derives every credential-protected mutation route and rejects OPS_READ_TOKEN", async () => {
    const audit = await subject();
    vi.stubEnv("OPS_READ_TOKEN", "valid-read-token");
    vi.stubEnv("COMPETITION_ADMIN_TOKEN", "different-admin-token");
    vi.stubEnv("RUNNER_CALLBACK_SECRET", "different-runner-token");
    const routes = await audit.deriveProtectedMutationRoutes({ cwd: repo });
    expect(routes.length).toBeGreaterThanOrEqual(8);
    for (const route of routes) {
      const loader = routeModules[`../../${route.file}`];
      expect(loader, route.file).toBeTypeOf("function");
      const routeModule = await loader();
      const handler = routeModule[route.method];
      const request = new Request(`http://localhost/${route.file.replace(/^app\//, "").replace(/\/route\.ts$/, "")}`, {
        method: route.method,
        headers: {
          authorization: "Bearer valid-read-token",
          "x-competition-admin-token": "valid-read-token",
          "x-runner-secret": "valid-read-token",
          "content-type": "application/json",
        },
        body: "{}",
      });
      const response = await handler(request, { params: Promise.resolve({ id: "access-audit-nonexistent" }) });
      expect(response.status, `${route.file} ${route.method}`).toBe(401);
    }
    vi.unstubAllEnvs();
  });

  it("fails closed when OPS_READ_TOKEN collides with a mutation credential", async () => {
    vi.stubEnv("OPS_READ_TOKEN", "collision-token");
    vi.stubEnv("COMPETITION_ADMIN_TOKEN", "collision-token");
    vi.stubEnv("RUNNER_CALLBACK_SECRET", "collision-token");
    const { credentialSeparationAttestation } = await import("../../lib/credential-separation.mjs");
    expect(credentialSeparationAttestation(process.env)).toMatchObject({ state: "invalid" });
    const { competitionAdminToken } = await import("../../lib/competition-config");
    const { verifyRunnerSecret } = await import("../../lib/runner-auth");
    expect(() => competitionAdminToken()).toThrow("credential_separation_invalid");
    expect(verifyRunnerSecret(new Request("http://localhost", { headers: { "x-runner-secret": "collision-token" } }))).toBe(false);
    vi.unstubAllEnvs();
  });

  it("never emits evidence secret values from the CLI", async () => {
    const audit = await subject();
    const writeOut = vi.fn();
    const raw = await evidence("viewer");
    raw.untrusted_secret = "cli-secret-sentinel";
    const exitCode = await audit.executeCli(["--", "--offline-evidence", fixture("viewer"), "--json"], { cwd: repo, writeOut, evidenceOverride: raw, now: "2026-08-03T10:00:00.000Z" });
    expect(exitCode).toBe(2);
    expect(writeOut).toHaveBeenCalledOnce();
    expect(writeOut.mock.calls[0][0]).not.toContain("cli-secret-sentinel");
  });

  it("never emits malformed JSON bytes or secret prefixes", async () => {
    const audit = await subject();
    const directory = await mkdtemp(join(tmpdir(), "access-audit-malformed-"));
    const path = join(directory, "evidence.json");
    await writeFile(path, '{"token":"malformed-secret-prefix-DO-NOT-ECHO" trailing');
    const writeErr = vi.fn();
    try {
      expect(await audit.executeCli(["--offline-evidence", path], { cwd: repo, writeErr })).toBe(64);
      expect(writeErr).toHaveBeenCalledWith("invalid_json");
      expect(writeErr.mock.calls[0][0]).not.toContain("malformed-secret-prefix");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
