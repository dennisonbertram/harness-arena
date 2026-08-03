import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
              : String(url).includes(`/v1/projects/${policy.capabilities.vercel.project_ids[0]}/members?`) ? String(url).includes("cursor=member-page-2")
                ? { value: [], pagination: { count: 0, nextCursor: null } }
                : { value: [], pagination: { count: 0, nextCursor: "member-page-2" } }
                : String(url).includes("/v1/access-groups?") ? { accessGroups: [], pagination: { count: 0, nextCursor: null } }
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
    expect(report.overall, JSON.stringify({ collected, report, requests })).toBe("observable");
    expect(commands.every(([binary, action]) => (binary === "gh" && action === "api") || (binary === "vercel" && ["env", "ls", "logs"].includes(action)))).toBe(true);
    expect(requests.every(([, method]) => method === "GET")).toBe(true);
    expect(requests.some(([url]) => url.includes("cursor=member-page-2"))).toBe(true);
    expect(requests.some(([url]) => url.includes("/api/ops/v1/inventory?kind=runs&limit=1"))).toBe(true);
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
              : target.includes("/v1/access-groups?") ? { accessGroups: [], pagination: { count: 0, nextCursor: null } }
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
      env: { OPS_READ_TOKEN: "never-follow-me", VERCEL_PROJECT_ID: policy.capabilities.vercel.project_ids[0], HARNESS_ARENA_URL: "https://harness-arena-psi.vercel.app" },
      commandRunner: vi.fn(async () => ({ exitCode: 1, stdout: "" })), fetchImpl,
    });
    expect(collected.ops.state).toBe("missing");
    expect(calls).toEqual([{ url: "https://harness-arena-psi.vercel.app/api/health", authorization: undefined }]);
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
