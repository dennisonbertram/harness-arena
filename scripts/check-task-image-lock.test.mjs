import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const checker = new URL("./check-task-image-lock.mjs", import.meta.url);
const initSource = readFileSync(new URL("./init.mjs", import.meta.url), "utf8");
const roots = new Set();
const digest = `sha256:${"a".repeat(64)}`;

function runChecker(transformEntry) {
  const root = mkdtempSync(path.join(tmpdir(), "task-image-lock-check-"));
  roots.add(root);
  mkdirSync(path.join(root, "config"), { recursive: true });
  mkdirSync(path.join(root, "tasks", "fixture-task"), { recursive: true });
  writeFileSync(path.join(root, "tasks", "fixture-task", "task.toml"), 'docker_image = "example.invalid/task:locked"\n');
  const entry = transformEntry({
    task_id: "fixture-task",
    lookup_ref: "example.invalid/task:locked",
    manifest_digest: digest,
    config_digest: digest,
  });
  writeFileSync(path.join(root, "config", "task-image-lock.json"), JSON.stringify({ version: 1, images: [entry] }));
  return spawnSync(process.execPath, [checker.pathname], { cwd: root, encoding: "utf8" });
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("task image lock local-init checker", () => {
  it.each([
    ["missing manifest digest", (entry) => { const changed = { ...entry }; delete changed.manifest_digest; return changed; }],
    ["invalid manifest digest", (entry) => ({ ...entry, manifest_digest: `sha256:${"A".repeat(64)}` })],
    ["missing config digest", (entry) => { const changed = { ...entry }; delete changed.config_digest; return changed; }],
    ["invalid config digest", (entry) => ({ ...entry, config_digest: "sha256:not-a-digest" })],
  ])("rejects %s while the derived task ID and reference remain exact", (_name, transformEntry) => {
    const result = runChecker(transformEntry);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("task image lock invalid");
  });

  it("runs before dependency installation and local seeding", () => {
    const checkerIndex = initSource.indexOf('"scripts/check-task-image-lock.mjs"');
    expect(checkerIndex).toBeGreaterThanOrEqual(0);
    expect(checkerIndex).toBeLessThan(initSource.indexOf('run("pnpm", ["install"'));
    expect(checkerIndex).toBeLessThan(initSource.indexOf('"scripts/seed-local.mjs"'));
  });
});
