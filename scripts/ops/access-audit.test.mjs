import { EventEmitter } from "node:events";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DELETE as inventoryDelete, PATCH as inventoryPatch, POST as inventoryPost, PUT as inventoryPut } from "../../app/api/ops/v1/inventory/route";
import { DELETE as readDelete, PATCH as readPatch, POST as readPost, PUT as readPut } from "../../app/api/ops/v1/read/route";
import { DELETE as rootDelete, PATCH as rootPatch, POST as rootPost, PUT as rootPut } from "../../app/api/ops/v1/route";
import { DELETE as summaryDelete, PATCH as summaryPatch, POST as summaryPost, PUT as summaryPut } from "../../app/api/ops/v1/summary/route";

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
    expect(audit.compareEnvironmentInventory(new Set(["OPS_READ_TOKEN", "NEW_UNMAPPED_ENV"]), policy)).toEqual(["NEW_UNMAPPED_ENV"]);
    expect(audit.deriveEnvironmentReferencesFromText("process.env.DIRECT; process.env['BRACKET']; const { DESTRUCTURED: alias } = process.env").names).toEqual(new Set(["BRACKET", "DESTRUCTURED", "DIRECT"]));
  });

  it.each([
    ["viewer", "observable", 0],
    ["app-only", "observable", 0],
    ["missing", "missing", 2],
    ["expired", "missing", 2],
    ["owner", "overprivileged", 3],
  ])("classifies the %s fixture as %s", async (name, state, exitCode) => {
    const audit = await subject();
    const report = audit.auditAccessEvidence(await audit.loadPolicy(policyPath), await evidence(name), { now: "2026-08-03T10:00:00.000Z" });
    expect(report.overall).toBe(state);
    expect(report.exit_code).toBe(exitCode);
    if (name === "owner") expect(report.systems.every((item) => item.state !== "observable") || report.systems.some((item) => item.state === "overprivileged")).toBe(true);
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

  it("proves OPS_READ_TOKEN cannot invoke any write method", async () => {
    vi.stubEnv("OPS_READ_TOKEN", "valid-read-token");
    const handlers = [rootPost, rootPut, rootPatch, rootDelete, summaryPost, summaryPut, summaryPatch, summaryDelete, inventoryPost, inventoryPut, inventoryPatch, inventoryDelete, readPost, readPut, readPatch, readDelete];
    for (const [index, handler] of handlers.entries()) {
      const method = ["POST", "PUT", "PATCH", "DELETE"][index % 4];
      const response = await handler(new Request("http://localhost/api/ops/v1", { method, headers: { authorization: "Bearer valid-read-token" } }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
    }
    vi.unstubAllEnvs();
  });

  it("never emits evidence secret values from the CLI", async () => {
    const audit = await subject();
    const writeOut = vi.fn();
    const raw = await evidence("viewer");
    raw.untrusted_secret = "cli-secret-sentinel";
    const exitCode = await audit.executeCli(["--evidence", fixture("viewer"), "--json"], { cwd: repo, writeOut, evidenceOverride: raw, now: "2026-08-03T10:00:00.000Z" });
    expect(exitCode).toBe(0);
    expect(writeOut).toHaveBeenCalledOnce();
    expect(writeOut.mock.calls[0][0]).not.toContain("cli-secret-sentinel");
  });
});
