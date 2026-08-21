import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBundle, findRunnerModuleClosure } from "./build-runner-bundle.mjs";

function listEntries(tgz: string): string[] {
  return execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

let workDir: string | undefined;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
});

// These tests really shell out to build a tarball (tar + filesystem I/O), so
// their duration varies with machine load -- ~1.6s idle but >5s when the full
// suite runs them in parallel, which intermittently tripped vitest's 5s
// default. The work is legitimately slow, so give it real headroom rather
// than let a loaded CI box fail a green build.
const BUNDLE_TEST_TIMEOUT_MS = 30_000;

describe("build-runner-bundle", () => {
  it("bundles the runner entrypoint", () => {
    workDir = mkdtempSync(path.join(tmpdir(), "runner-bundle-test-"));
    const outFile = path.join(workDir, "runner-bundle.tgz");

    buildBundle({ outFile });
    const entries = listEntries(outFile);

    expect(entries).toContain("scripts/runner/runner.mjs");
  }, BUNDLE_TEST_TIMEOUT_MS);
});

describe("findRunnerModuleClosure", () => {
  it("derives a deterministic transitive closure across static and dynamic imports", () => {
    workDir = mkdtempSync(path.join(tmpdir(), "runner-module-closure-test-"));
    writeFileSync(
      path.join(workDir, "runner.mjs"),
      'import "./alpha.mjs";\nawait import("./nested/bravo.mjs");\n',
    );
    mkdirSync(path.join(workDir, "nested"));
    writeFileSync(path.join(workDir, "alpha.mjs"), 'export { value } from "./nested/charlie.mjs";\n');
    writeFileSync(path.join(workDir, "nested", "bravo.mjs"), 'import "./charlie.mjs";\n');
    writeFileSync(path.join(workDir, "nested", "charlie.mjs"), "export const value = 1;\n");

    expect(findRunnerModuleClosure({ runnerDir: workDir })).toEqual([
      "alpha.mjs",
      "nested/bravo.mjs",
      "nested/charlie.mjs",
      "runner.mjs",
    ]);
  });

  it("follows parent-relative imports that stay inside the runner directory", () => {
    workDir = mkdtempSync(path.join(tmpdir(), "runner-module-closure-test-"));
    mkdirSync(path.join(workDir, "nested"));
    writeFileSync(path.join(workDir, "runner.mjs"), 'import "./nested/child.mjs";\n');
    writeFileSync(path.join(workDir, "nested", "child.mjs"), 'import "../parent.mjs";\n');
    writeFileSync(path.join(workDir, "parent.mjs"), "export const value = 1;\n");

    expect(findRunnerModuleClosure({ runnerDir: workDir })).toEqual([
      "nested/child.mjs",
      "parent.mjs",
      "runner.mjs",
    ]);
  });

  it.each([
    ['import "./missing.mjs";\n', "missing"],
    ['import "./../outside.mjs";\n', "outside"],
  ])("fails closed for an invalid local module graph", (source, expectedMessage) => {
    workDir = mkdtempSync(path.join(tmpdir(), "runner-module-closure-test-"));
    writeFileSync(path.join(workDir, "runner.mjs"), source);

    expect(() => findRunnerModuleClosure({ runnerDir: workDir })).toThrow(expectedMessage);
  });

  // A dynamic import whose specifier is not a plain string literal (template
  // literal, variable, concatenation) cannot be resolved by the extractor.
  // Silently omitting the module is exactly how the past production failure
  // ("Cannot find module '.../gateway-proxy.mjs'") happened -- so abort the
  // build instead, naming the file and line.
  it("fails closed on a dynamic import with a template-literal specifier", () => {
    workDir = mkdtempSync(path.join(tmpdir(), "runner-module-closure-test-"));
    writeFileSync(
      path.join(workDir, "runner.mjs"),
      'const name = "gateway";\nawait import(`./${name}.mjs`);\n',
    );
    writeFileSync(path.join(workDir, "gateway.mjs"), "export const value = 1;\n");

    expect(() => findRunnerModuleClosure({ runnerDir: workDir })).toThrow(
      /runner\.mjs:2 could not resolve relative import/,
    );
  });

  it("fails closed on a relative import that does not resolve to a local .mjs path", () => {
    workDir = mkdtempSync(path.join(tmpdir(), "runner-module-closure-test-"));
    writeFileSync(path.join(workDir, "runner.mjs"), 'import "./helper.js";\n');
    writeFileSync(path.join(workDir, "helper.js"), "export const value = 1;\n");

    expect(() => findRunnerModuleClosure({ runnerDir: workDir })).toThrow(
      /runner\.mjs:1 relative import does not resolve to a local \.mjs path: "\.\/helper\.js"/,
    );
  });
});

describe("security: the public bundle carries no grading materials", () => {
  it("contains runner code only, never a tasks tree or verifier files", () => {
    workDir = mkdtempSync(path.join(tmpdir(), "runner-bundle-test-"));
    const outFile = path.join(workDir, "runner-bundle.tgz");

    buildBundle({ outFile });
    const entries = listEntries(outFile);
    const files = entries.filter((entry) => !entry.endsWith("/"));

    expect(entries.some((entry) => entry.startsWith("tasks/"))).toBe(false);
    expect(
      entries.some((entry) => /(?:^|\/)(?:test\.sh|test_outputs\.py(?:\.b64)?)$/.test(entry)),
    ).toBe(false);
    expect(files.every((entry) => entry.startsWith("scripts/runner/"))).toBe(true);
  }, BUNDLE_TEST_TIMEOUT_MS);
});

// A run failed in production with "Cannot find module
// '/opt/runner/scripts/runner/gateway-proxy.mjs'": the bundle copied a
// hand-maintained list of files, and a new module the runner imports was not
// on it. A literal list cannot catch that -- it has to be DERIVED from what
// the runner actually imports, so adding a module can never silently break
// dispatch again.
describe("regression: every module the runner imports is bundled", () => {
  function importedModuleClosure(entry: string): string[] {
    const runnerDir = path.join(process.cwd(), "scripts", "runner");
    const pending = [entry];
    const seen = new Set<string>();

    while (pending.length) {
      const file = pending.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = readFileSync(path.join(runnerDir, file), "utf8");
      const specifiers = [
        ...src.matchAll(
          /\b(?:import|export)\s+(?:(?:[^"'()]*?)\s+from\s+)?["']((?:\.{1,2}\/)[^"']+\.mjs)["']/g,
        ),
        ...src.matchAll(/\bimport\s*\(\s*["']((?:\.{1,2}\/)[^"']+\.mjs)["']\s*\)/g),
      ].map((match) => match[1]);
      for (const specifier of specifiers) {
        const dependency = path.relative(
          runnerDir,
          path.resolve(path.dirname(path.join(runnerDir, file)), specifier),
        );
        if (!seen.has(dependency)) pending.push(dependency);
      }
      pending.sort();
    }

    return [...seen].sort();
  }

  it("bundles the complete local module graph rooted at runner.mjs", () => {
    workDir = mkdtempSync(path.join(tmpdir(), "runner-bundle-test-"));
    const outFile = path.join(workDir, "runner-bundle.tgz");

    buildBundle({ outFile });
    const entries = listEntries(outFile);

    const required = importedModuleClosure("runner.mjs");
    expect(required.length).toBeGreaterThan(1);
    for (const modulePath of required) {
      expect(entries, `runner imports ${modulePath} but the bundle omits it`).toContain(
        `scripts/runner/${modulePath}`,
      );
    }
  }, BUNDLE_TEST_TIMEOUT_MS);
});

describe("regression: derived fixture bundles remain executable", () => {
  it("executes a nested dependency that imports a parent module", () => {
    workDir = mkdtempSync(path.join(tmpdir(), "runner-bundle-fixture-test-"));
    const runnerDir = path.join(workDir, "source");
    const extractedDir = path.join(workDir, "extracted");
    const outFile = path.join(workDir, "runner-bundle.tgz");
    mkdirSync(path.join(runnerDir, "nested"), { recursive: true });
    mkdirSync(extractedDir);
    writeFileSync(
      path.join(runnerDir, "runner.mjs"),
      'import { value } from "./nested/child.mjs";\nconsole.log(value);\n',
    );
    writeFileSync(
      path.join(runnerDir, "nested", "child.mjs"),
      'export { value } from "../parent.mjs";\n',
    );
    writeFileSync(path.join(runnerDir, "parent.mjs"), 'export const value = "parent-loaded";\n');

    buildBundle({ outFile, runnerDir });
    execFileSync("tar", ["-xzf", outFile, "-C", extractedDir]);

    expect(
      execFileSync(process.execPath, [path.join(extractedDir, "scripts", "runner", "runner.mjs")], {
        encoding: "utf8",
      }).trim(),
    ).toBe("parent-loaded");
  }, BUNDLE_TEST_TIMEOUT_MS);

  it("dereferences an in-tree module symlink before packaging", () => {
    workDir = mkdtempSync(path.join(tmpdir(), "runner-bundle-fixture-test-"));
    const runnerDir = path.join(workDir, "source");
    const extractedDir = path.join(workDir, "extracted");
    const outFile = path.join(workDir, "runner-bundle.tgz");
    mkdirSync(runnerDir);
    mkdirSync(extractedDir);
    writeFileSync(
      path.join(runnerDir, "runner.mjs"),
      'import { value } from "./linked.mjs";\nconsole.log(value);\n',
    );
    const realModule = path.join(runnerDir, "real.mjs");
    writeFileSync(realModule, 'export const value = "symlink-loaded";\n');
    symlinkSync(realModule, path.join(runnerDir, "linked.mjs"));

    buildBundle({ outFile, runnerDir });
    rmSync(runnerDir, { recursive: true, force: true });
    execFileSync("tar", ["-xzf", outFile, "-C", extractedDir]);

    const extractedModule = path.join(extractedDir, "scripts", "runner", "linked.mjs");
    expect(lstatSync(extractedModule).isSymbolicLink()).toBe(false);
    expect(
      execFileSync(process.execPath, [path.join(extractedDir, "scripts", "runner", "runner.mjs")], {
        encoding: "utf8",
      }).trim(),
    ).toBe("symlink-loaded");
  }, BUNDLE_TEST_TIMEOUT_MS);
});

describe("regression: bundle excludes files the sandbox never needs", () => {
  it("does not include instruction.md or task.toml -- task instructions travel via TASKS_JSON_B64, not the bundle", () => {
    workDir = mkdtempSync(path.join(tmpdir(), "runner-bundle-test-"));
    const outFile = path.join(workDir, "runner-bundle.tgz");

    buildBundle({ outFile });
    const entries = listEntries(outFile);

    expect(entries.some((e) => e.endsWith("instruction.md"))).toBe(false);
    expect(entries.some((e) => e.endsWith("task.toml"))).toBe(false);
  }, BUNDLE_TEST_TIMEOUT_MS);
});
