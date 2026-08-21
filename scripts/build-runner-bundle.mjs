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

// Extracts every relative import specifier from `source`. Any relative
// reference the extractor cannot resolve to a literal local .mjs path --
// a template-literal/variable dynamic import, a non-.mjs extension -- throws
// naming the module and line, instead of being silently dropped from the
// bundle (the failure mode behind the past "Cannot find module
// '.../gateway-proxy.mjs'" production incident).
function localModuleSpecifiers(source, modulePath) {
  const lineOf = (index) => source.slice(0, index).split("\n").length;
  const fail = (line, specifier, reason) => {
    throw new Error(
      `${modulePath}:${line} ${reason}: "${specifier}" -- the bundle closure is derived from ` +
        `literal imports, so every relative import must be a plain string literal ending in .mjs`,
    );
  };

  const specifiers = [];
  const staticPattern =
    /\b(?:import|export)\s+(?:(?:[^"'`()]*?)\s+from\s+)?["']((?:\.{1,2}\/)[^"']*)["']/g;
  for (const match of source.matchAll(staticPattern)) {
    const [, specifier] = match;
    if (!specifier.endsWith(".mjs")) {
      fail(lineOf(match.index), specifier, "relative import does not resolve to a local .mjs path");
    }
    specifiers.push(specifier);
  }

  const dynamicPattern = /\bimport\s*\(\s*([^)]*?)\s*\)/g;
  for (const match of source.matchAll(dynamicPattern)) {
    const argument = match[1];
    const literal = argument.match(/^(["'])((?:\.{1,2}\/)[^"']*)\1$/);
    if (!literal) {
      if (!/(?:\.{1,2}\/)/.test(argument)) continue; // bare/package/builtin specifier
      fail(
        lineOf(match.index),
        argument,
        "could not resolve relative import -- dynamic import specifier is not a string literal",
      );
    }
    const specifier = literal[2];
    if (!specifier.endsWith(".mjs")) {
      fail(lineOf(match.index), specifier, "relative import does not resolve to a local .mjs path");
    }
    specifiers.push(specifier);
  }

  return [...new Set(specifiers)].sort();
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
    for (const specifier of localModuleSpecifiers(source, relativeSource)) {
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
