import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (name: string) => JSON.parse(readFileSync(join(packageDirectory, name), "utf8")) as Record<string, unknown>;
const npmCache = mkdtempSync(join(tmpdir(), "harness-arena-npm-pack-"));

afterAll(() => rmSync(npmCache, { recursive: true, force: true }));

describe("published MCP package contract", () => {
  it("is a first-class root CI surface with clean install, tests, build, and package proof", () => {
    const workflow = readFileSync(join(packageDirectory, "..", ".github", "workflows", "ci.yml"), "utf8");
    expect(workflow).toMatch(/working-directory:\s*mcp/);
    expect(workflow).toMatch(/run:\s*npm ci/);
    expect(workflow).toMatch(/run:\s*npm test/);
    expect(workflow).toMatch(/run:\s*npm pack --dry-run/);
  });

  it("ships an operator-safe usage contract for auth, untrusted content, traces, and payouts", () => {
    const readme = readFileSync(join(packageDirectory, "README.md"), "utf8");
    expect(readme).toMatch(/stdio/i);
    expect(readme).toMatch(/login_start/);
    expect(readme).toMatch(/untrusted/i);
    expect(readme).toMatch(/private key.*never|never.*private key/i);
    expect(readme).toMatch(/ensure_payout_wallet.*feature_unavailable/is);
    expect(readme).toMatch(/development environment|non-production/i);
  });

  it("cleans before compiling, excludes test sources from dist, and keeps test discovery source-only", () => {
    const packageJson = readJson("package.json") as { scripts?: Record<string, string> };
    const tsconfig = readJson("tsconfig.json") as { exclude?: string[] };

    expect(packageJson.scripts?.prebuild).toBe("node scripts/clean-dist.mjs");
    expect(packageJson.scripts?.test).toBe("vitest run src");
    expect(tsconfig.exclude).toEqual(expect.arrayContaining(["src/**/*.test.ts"]));
  });

  it("packs only production runtime declarations and JavaScript, never tests or fixtures", () => {
    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: packageDirectory,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: npmCache },
    });
    const pack = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    const paths = pack[0].files.map((file) => file.path);

    expect(paths).toEqual(expect.arrayContaining([
      "package.json",
      "dist/index.js",
      "dist/client.js",
      "dist/server.js",
      "dist/credentials.js",
      "dist/device-attempt-store.js",
    ]));
    expect(paths.some((path) => path.includes(".test.") || path.startsWith("test-fixtures/") || path.includes("stdio-compatibility-server")))
      .toBe(false);
  });
});
