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
      const body = String(url).includes("/v2/user") ? { id: "viewer-user" }
        : String(url).includes("/v2/teams?") ? { teams: [{ id: "team-one", membership: { role: "VIEWER" } }] }
          : String(url).includes("/v9/projects/") ? { id: policy.capabilities.vercel.project_ids[0], members: [] }
            : String(url).includes("/v6/user/tokens") ? { tokens: [{ prefix: "viewer-", suffix: "token", scopes: [{ type: "team", teamId: "team-one" }] }] }
            : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    });
    const env = {
      OPS_READ_TOKEN: "read-token",
      VERCEL_TOKEN: "viewer-token",
      VERCEL_TEAM_ID: "team-one",
      VERCEL_PROJECT_ID: policy.capabilities.vercel.project_ids[0],
      HARNESS_ARENA_URL: "https://development.example.test",
    };
    const collected = await audit.collectActiveAccessEvidence({ policy, role: "monitor", cwd: repo, env, commandRunner, fetchImpl, now: "2026-08-03T10:00:00.000Z" });
    expect(audit.auditAccessEvidence(policy, collected, { authority: "authoritative", now: "2026-08-03T10:00:00.000Z" }).overall).toBe("observable");
    expect(commands.every(([binary, action]) => (binary === "gh" && action === "api") || (binary === "vercel" && ["env", "ls", "logs"].includes(action)))).toBe(true);
    expect(requests.every(([, method]) => method === "GET")).toBe(true);
  });

  it("normalizes a project-scoped Vercel token with the inherited Viewer role", async () => {
    const audit = await subject();
    expect(audit.normalizeVercelAccess({
      projectId: "project-one",
      userId: "user-one",
      token: audit.selectActiveVercelToken({ tokens: [{ prefix: "vcp_", suffix: "tail", scopes: [{ type: "project", projectId: "project-one" }] }] }, "vcp_secret-tail"),
      team: { membership: { role: "VIEWER" } },
      project: { members: [] },
    })).toMatchObject({ token_project_id: "project-one", team_role: "VIEWER", project_role: "VIEWER", role_source: "team_inherited" });
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
    const audit = await subject();
    vi.stubEnv("OPS_READ_TOKEN", "collision-token");
    vi.stubEnv("COMPETITION_ADMIN_TOKEN", "collision-token");
    vi.stubEnv("RUNNER_CALLBACK_SECRET", "collision-token");
    const collisions = audit.findOpsCredentialCollisions(process.env, await audit.loadPolicy(policyPath));
    expect(collisions).toEqual(expect.arrayContaining(["COMPETITION_ADMIN_TOKEN", "RUNNER_CALLBACK_SECRET"]));
    const { competitionAdminToken } = await import("../../lib/competition-config");
    const { verifyRunnerSecret } = await import("../../lib/runner-auth");
    expect(competitionAdminToken()).toBeUndefined();
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
