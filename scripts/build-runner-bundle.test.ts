import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBundle } from "./build-runner-bundle.mjs";

const TASKS_DIR = path.join(process.cwd(), "tasks");

function realTaskIds(): string[] {
  return readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

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
  it("bundles scripts/runner/runner.mjs, scripts/runner/lib.mjs, and the first task's tests/test.sh", () => {
    workDir = mkdtempSync(path.join(tmpdir(), "runner-bundle-test-"));
    const outFile = path.join(workDir, "runner-bundle.tgz");
    const firstTaskId = realTaskIds()[0];

    buildBundle({ outFile });
    const entries = listEntries(outFile);

    expect(entries).toContain("scripts/runner/runner.mjs");
    expect(entries).toContain("scripts/runner/lib.mjs");
    expect(entries).toContain(`tasks/${firstTaskId}/tests/test.sh`);
  }, BUNDLE_TEST_TIMEOUT_MS);

  it("bundles tests/test.sh for every task getTasks() would load, not just the first", () => {
    workDir = mkdtempSync(path.join(tmpdir(), "runner-bundle-test-"));
    const outFile = path.join(workDir, "runner-bundle.tgz");

    buildBundle({ outFile });
    const entries = listEntries(outFile);

    for (const id of realTaskIds()) {
      expect(entries).toContain(`tasks/${id}/tests/test.sh`);
    }
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
