import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { safeChildEnv, SUPPORTED_NODE_RANGE } from "./init-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

function ignoredCandidates(candidates) {
  const output = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd: root,
    input: `${candidates.join("\n")}\n`,
    encoding: "utf8",
  });
  return output.trim().split("\n");
}

describe("clean clone toolchain contract", () => {
  it("derives its pnpm, Node, ignore, and branch rules from their runtime authorities", async () => {
    const packageJson = JSON.parse(read("package.json"));
    const ci = read(".github/workflows/ci.yml");
    const readme = read("README.md");
    const pnpmAction = ci.match(/- uses: pnpm\/action-setup[^\n]*(?<configuration>[\s\S]*?)(?=\n\s*- uses:|\n\s*- run:|$)/);
    const ciNode = ci.match(/node-version:\s*(?<version>\d+)/)?.groups?.version;
    const packageManager = packageJson.packageManager.match(/^pnpm@(?<version>\d+\.\d+\.\d+)$/)?.groups;
    const documentedPnpmVersions = [...readme.matchAll(/\bpnpm\s+(?<version>\d+\.\d+\.\d+)\b/gi)]
      .map((match) => match.groups.version);

    expect(pnpmAction).not.toBeNull();
    expect(pnpmAction.groups.configuration).not.toMatch(/^\s+version:/m);
    expect(packageManager).toBeDefined();
    expect([...new Set(documentedPnpmVersions)]).toEqual([packageManager.version]);
    expect(packageJson.engines).toEqual({ node: SUPPORTED_NODE_RANGE });
    expect(read(".nvmrc").trim()).toBe(ciNode);
    expect(ignoredCandidates([".env.example", ".env.local"])).toEqual([".env.local"]);
    await expect(safeChildEnv(root, {}, { HARNESS_GIT_BRANCH: "main" })).rejects.toThrow(/forbidden on main/);
    expect(readme).toContain("corepack enable");
    expect(readme).toContain("git clone --branch dev");
  });

  it("resolves every repository-local README link", () => {
    const localLinks = [...read("README.md").matchAll(/\[[^\]]+\]\((?<target>[^)]+)\)/g)]
      .map((match) => match.groups.target)
      .filter((target) => !/^(?:[a-z]+:|#)/i.test(target))
      .map((target) => target.split(/[?#]/, 1)[0]);

    expect(localLinks.length).toBeGreaterThan(0);
    for (const target of localLinks) {
      expect(existsSync(path.resolve(root, target)), target).toBe(true);
    }
  });

  it("derives the local-init Node requirement from the runtime authority", () => {
    const localInit = read("docs/runbooks/local-init.md").replace(/\s+/g, " ");
    expect(localInit).toContain(`Node.js \`${SUPPORTED_NODE_RANGE}\``);
  });
});
