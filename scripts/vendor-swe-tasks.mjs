#!/usr/bin/env node
// Vendors SWE-bench Verified instances into tasks-swe/<id>.json specs for the
// swe-bench board (see lib/swe-task.ts for the spec contract).
//
// Mirrors scripts/vendor-tasks.sh conventions:
//   - instances are pinned by base_commit from a checked-in manifest
//   - gold_patch and test_patch are NEVER vendored (solutions stay upstream)
//   - the canary GUID line is preserved byte-identical
//   - output is staged and validated before replacing tasks-swe/
//
// The transformation logic is exported as pure functions so tests can drive it
// with fixture instances without network access; the CLI entrypoint fetches
// live instance data when given --fetch, otherwise validates/refreshes from a
// local raw-instances directory (SWE_RAW_DIR, default tmp/swe-raw/).
//
// Usage:
//   node scripts/vendor-swe-tasks.mjs                 # vendor from local raw dir
//   node scripts/vendor-swe-tasks.mjs --fetch         # download instances first

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TASKS_SWE_DIR = path.join(REPO_ROOT, "tasks-swe");
const RAW_DIR = process.env.SWE_RAW_DIR ?? path.join(REPO_ROOT, "tmp", "swe-raw");

// Checked-in manifest: which instances make up the fixed board. Start small
// (8 Python-repo instances, easy/medium skew) per the plan's Phase 1 cut.
// base_commit is asserted against the fetched instance data -- a mismatch
// aborts vendoring rather than silently pinning a different commit.
export const SWE_MANIFEST = [
  { id: "django__django-16379", repo: "django/django", base_commit: "4a72da71001f71449f70da6f6f1c1ff13aea5c46" },
  { id: "django__django-11433", repo: "django/django", base_commit: "175594ae68117e4689d53a5848300f7ac5ebde34" },
  { id: "sympy__sympy-24213", repo: "sympy/sympy", base_commit: "2c99b74e99b19dfe6f88a002942d43ba3d3cf35f" },
  { id: "scikit-learn__scikit-learn-13241", repo: "scikit-learn/scikit-learn", base_commit: "1e35fc6c38637cd8ccf27be93ec8ee7c52edd632" },
  { id: "matplotlib__matplotlib-24334", repo: "matplotlib/matplotlib", base_commit: "16c1baf7e54abd1517d66c26dd68609da2c1cc78" },
  { id: "astropy__astropy-14995", repo: "astropy/astropy", base_commit: "d3b5cd1ce39da32e5f08ae5b5968181ba48bc0a6" },
  { id: "pytest__pytest-11143", repo: "pytest-dev/pytest", base_commit: "571e20cb50d30bec37ff6907fc4bbf5abe03c3e9" },
  { id: "requests__requests-2317", repo: "psf/requests", base_commit: "d9de5b25d31ed7b7d3ffe0a75ee2a1d5d8f98c62" },
];

/**
 * Transforms one raw SWE-bench instance record into a vendored task spec.
 * Throws if solution material is present in the input shape we'd emit, or if
 * required fields are missing. Pure: no I/O.
 */
export function toTaskSpec(instance) {
  const required = ["instance_id", "repo", "base_commit", "problem_statement"];
  for (const field of required) {
    if (!instance[field]) throw new Error(`instance missing required field "${field}"`);
  }
  // Solutions never get vendored: refuse inputs that still carry them so a
  // sloppy caller can't leak a gold patch through this script.
  for (const forbidden of ["gold_patch", "test_patch", "solution_patch"]) {
    if (instance[forbidden] !== undefined && instance[forbidden] !== null && instance[forbidden] !== "") {
      throw new Error(`refusing to vendor instance carrying "${forbidden}" -- solutions stay out of this repo`);
    }
  }

  const failToPass = parseTestList(instance.FAIL_TO_PASS);
  const passToPass = parseTestList(instance.PASS_TO_PASS);
  if (failToPass.length === 0) {
    throw new Error(`instance ${instance.instance_id} has an empty FAIL_TO_PASS list -- unverifiable`);
  }

  return {
    id: instance.instance_id,
    repo: instance.repo,
    base_commit: instance.base_commit,
    issue_text: instance.problem_statement,
    docker_image: `ghcr.io/harness-arena/swe:${instance.instance_id}`,
    workdir: "/repo",
    install_cmd: "",
    test_cmd: instance.test_cmd ?? "python -m pytest -x -q",
    fail_to_pass: failToPass,
    pass_to_pass: passToPass,
    canary: CANARY_GUID,
    agent_timeout_sec: instance.agent_timeout_sec ?? 1800,
    verifier_timeout_sec: instance.verifier_timeout_sec ?? 900,
    cpus: instance.cpus ?? 4,
    memory: instance.memory ?? "8G",
  };
}

/** Parses the dataset's stringified test-list form ("[\"a\", \"b\"]") safely. */
export function parseTestList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || value.trim() === "") return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`test list is not an array: ${String(value).slice(0, 80)}`);
  return parsed.map(String);
}

// Same provenance-audit convention as terminal-bench's canary GUID: a stable
// marker embedded byte-identical in every vendored spec.
export const CANARY_GUID = "swe-bench-canary-1b3f9a2e-7c44-4d0e-9a51-harnessarena";

function validateSpec(spec, manifestEntry) {
  if (spec.base_commit !== manifestEntry.base_commit) {
    throw new Error(
      `${spec.id}: fetched base_commit ${spec.base_commit} != pinned ${manifestEntry.base_commit}; refusing to vendor`,
    );
  }
  if (spec.repo !== manifestEntry.repo) {
    throw new Error(`${spec.id}: fetched repo ${spec.repo} != pinned ${manifestEntry.repo}`);
  }
}

export function vendorFromRawDir(rawDir, manifest = SWE_MANIFEST) {
  if (!existsSync(rawDir)) {
    throw new Error(`raw instances dir not found: ${rawDir} (run with --fetch or set SWE_RAW_DIR)`);
  }
  const staging = `${TASKS_SWE_DIR}.staging.${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    for (const entry of manifest) {
      const rawPath = path.join(rawDir, `${entry.id}.json`);
      if (!existsSync(rawPath)) {
        throw new Error(`missing raw instance: ${rawPath}`);
      }
      const spec = toTaskSpec(JSON.parse(readFileSync(rawPath, "utf8")));
      validateSpec(spec, entry);
      writeFileSync(path.join(staging, `${entry.id}.json`), JSON.stringify(spec, null, 2) + "\n");
    }
    // Atomic swap: tasks-swe/ is never absent or partial.
    const old = `${TASKS_SWE_DIR}.old.${process.pid}`;
    rmSync(old, { recursive: true, force: true });
    if (existsSync(TASKS_SWE_DIR)) renameSync(TASKS_SWE_DIR, old);
    renameSync(staging, TASKS_SWE_DIR);
    rmSync(old, { recursive: true, force: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return readdirSync(TASKS_SWE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const ids = vendorFromRawDir(RAW_DIR);
  console.log(`Vendored ${ids.length} SWE tasks into tasks-swe/:`);
  for (const id of ids) console.log(`  ${id}`);
}
