import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { safeChildEnv } from "./init-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

function isIgnored(candidate) {
  try {
    execFileSync("git", ["check-ignore", "--no-index", candidate], { cwd: root, stdio: "ignore" });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

describe("clean clone toolchain contract", () => {
  it("derives its pnpm, Node, ignore, and branch rules from their runtime authorities", async () => {
    const packageJson = JSON.parse(read("package.json"));
    const ci = read(".github/workflows/ci.yml");
    const initLib = read("scripts/init-lib.mjs");
    const readme = read("README.md");
    const pnpmAction = ci.match(/- uses: pnpm\/action-setup[^\n]*(?<configuration>[\s\S]*?)(?=\n\s*- uses:|\n\s*- run:|$)/);
    const ciNode = ci.match(/node-version:\s*(?<version>\d+)/)?.groups?.version;
    const initNode = initLib.match(/const REQUIRED_NODE_VERSION = \[(?<major>\d+), (?<minor>\d+), (?<patch>\d+)\]/)?.groups;

    expect(pnpmAction).not.toBeNull();
    expect(pnpmAction.groups.configuration).not.toMatch(/^\s+version:/m);
    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(initNode).toBeDefined();
    expect(packageJson.engines).toEqual({ node: `>=${initNode.major}.${initNode.minor}.${initNode.patch}` });
    expect(read(".nvmrc").trim()).toBe(ciNode);
    expect(isIgnored(".env.example")).toBe(false);
    expect(isIgnored(".env.local")).toBe(true);
    await expect(safeChildEnv(root, {}, { HARNESS_GIT_BRANCH: "main" })).rejects.toThrow(/forbidden on main/);
    expect(readme).toContain("corepack enable");
    expect(readme).toContain("git clone --branch dev");
  });
});
