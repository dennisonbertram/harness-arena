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
