#!/usr/bin/env node
// Packages the in-sandbox runner (scripts/runner/{runner.mjs,lib.mjs}) plus
// every task's tests/ dir into public/runner-bundle.tgz. The bundle is
// curled and extracted inside the sandbox to /opt/runner (see
// lib/sandbox.ts), so this must produce exactly the layout runner.mjs
// expects: scripts/runner/*.mjs and tasks/<id>/tests/*.
//
// Task ids are derived from tasks/ subdirectories that contain a task.toml
// (the same set lib/tasks.ts#getTasks() loads) rather than importing that
// TS module directly, so this plain-Node script has no TS-loader
// dependency at build time.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TASKS_DIR = path.join(ROOT, "tasks");
const RUNNER_DIR = path.join(ROOT, "scripts", "runner");
const DEFAULT_OUT_FILE = path.join(ROOT, "public", "runner-bundle.tgz");

function taskIds() {
  return readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(TASKS_DIR, entry.name, "task.toml")))
    .map((entry) => entry.name)
    .sort();
}

export function buildBundle({ outFile = DEFAULT_OUT_FILE } = {}) {
  const stageDir = path.join(ROOT, ".runner-bundle-stage");
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(path.join(stageDir, "scripts", "runner"), { recursive: true });
  cpSync(path.join(RUNNER_DIR, "runner.mjs"), path.join(stageDir, "scripts", "runner", "runner.mjs"));
  cpSync(path.join(RUNNER_DIR, "lib.mjs"), path.join(stageDir, "scripts", "runner", "lib.mjs"));

  for (const id of taskIds()) {
    const testsDst = path.join(stageDir, "tasks", id, "tests");
    mkdirSync(testsDst, { recursive: true });
    cpSync(path.join(TASKS_DIR, id, "tests"), testsDst, { recursive: true });
  }

  mkdirSync(path.dirname(outFile), { recursive: true });
  // ponytail: no --sort/--mtime normalization (macOS's bundled bsdtar
  // doesn't support them) -- the staged file *set* is deterministic
  // (sorted task ids, fixed copy order) even though the gzip bytes aren't
  // guaranteed byte-identical across machines. Upgrade to a real
  // reproducible-tar toolchain if bit-for-bit determinism ever matters.
  execFileSync("tar", ["--numeric-owner", "--owner=0", "--group=0", "-czf", outFile, "-C", stageDir, "scripts", "tasks"]);

  rmSync(stageDir, { recursive: true, force: true });
  return outFile;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outFile = buildBundle();
  console.log(`runner bundle written to ${outFile}`);
}
