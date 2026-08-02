#!/usr/bin/env node
// Packages the in-sandbox runner's complete local module graph into
// public/runner-bundle.tgz. The bundle is curled and extracted inside the
// sandbox to /opt/runner (see lib/sandbox.ts), so this must produce exactly
// the scripts/runner/*.mjs layout runner.mjs expects.
//
// Grading materials (tasks/<id>/tests/*) are deliberately excluded. This
// artifact is publicly downloadable during sandbox bootstrap; publishing the
// assertions would let a submitted harness reward-hack its evaluation. The
// outer runner fetches tests later from authenticated GET /api/runner-tests,
// after which it copies them into the task container only for verification.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_DIR = path.join(ROOT, "scripts", "runner");
const DEFAULT_OUT_FILE = path.join(ROOT, "public", "runner-bundle.tgz");

function localModuleSpecifiers(source) {
  const matches = [
    ...source.matchAll(
      /\b(?:import|export)\s+(?:(?:[^"'()]*?)\s+from\s+)?["']((?:\.{1,2}\/)[^"']+\.mjs)["']/g,
    ),
    ...source.matchAll(/\bimport\s*\(\s*["']((?:\.{1,2}\/)[^"']+\.mjs)["']\s*\)/g),
  ];
  return [...new Set(matches.map((match) => match[1]))].sort();
}

function relativePathInside(root, candidate, description) {
  const relative = path.relative(root, candidate);
  if (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`${description} resolves outside runner directory`);
  }
  return relative;
}

export function findRunnerModuleClosure({ runnerDir = RUNNER_DIR, entry = "runner.mjs" } = {}) {
  const root = path.resolve(runnerDir);
  const realRoot = realpathSync(root);
  const pending = [entry];
  const seen = new Set();

  while (pending.length) {
    pending.sort();
    const modulePath = pending.shift();
    if (seen.has(modulePath)) continue;

    const sourcePath = path.resolve(root, modulePath);
    const relativeSource = relativePathInside(root, sourcePath, `runner module ${modulePath}`);
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
      throw new Error(`runner module is missing: ${relativeSource}`);
    }

    const realSource = realpathSync(sourcePath);
    relativePathInside(realRoot, realSource, `runner module ${relativeSource}`);
    seen.add(relativeSource);

    const source = readFileSync(realSource, "utf8");
    for (const specifier of localModuleSpecifiers(source)) {
      const dependencyPath = path.resolve(path.dirname(sourcePath), specifier);
      const dependency = relativePathInside(
        root,
        dependencyPath,
        `runner import ${specifier} from ${relativeSource}`,
      );
      if (!seen.has(dependency)) pending.push(dependency);
    }
  }

  return [...seen].sort();
}

export function buildBundle({
  outFile = DEFAULT_OUT_FILE,
  runnerDir = RUNNER_DIR,
  entry = "runner.mjs",
} = {}) {
  const root = path.resolve(runnerDir);
  const realRoot = realpathSync(root);
  const stageDir = mkdtempSync(path.join(tmpdir(), "runner-bundle-stage-"));

  try {
    for (const modulePath of findRunnerModuleClosure({ runnerDir: root, entry })) {
      const source = path.join(root, modulePath);
      const realSource = realpathSync(source);
      relativePathInside(realRoot, realSource, `runner module ${modulePath}`);

      const destination = path.join(stageDir, "scripts", "runner", modulePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      // Copy the validated target bytes. cpSync preserves a source symlink,
      // which can turn an otherwise valid in-tree module into a dangling
      // host-path link after extraction in /opt/runner.
      copyFileSync(realSource, destination);
    }

    mkdirSync(path.dirname(outFile), { recursive: true });
    // ponytail: no --sort/--mtime normalization (macOS's bundled bsdtar
    // doesn't support them) -- the staged file *set* is deterministic
    // (sorted module closure) even though the gzip bytes aren't
    // guaranteed byte-identical across machines. Upgrade to a real
    // reproducible-tar toolchain if bit-for-bit determinism ever matters.
    execFileSync("tar", [
      "--numeric-owner",
      "--owner=0",
      "--group=0",
      "-czf",
      outFile,
      "-C",
      stageDir,
      "scripts",
    ]);
    return outFile;
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outFile = buildBundle();
  console.log(`runner bundle written to ${outFile}`);
}
