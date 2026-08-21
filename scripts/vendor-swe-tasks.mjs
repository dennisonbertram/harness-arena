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
// (8 Python-repo instances across 5 repos) per the plan's Phase 1 cut. Every
// id/base_commit below was pulled from princeton-nlp/SWE-bench_Verified and is
// re-asserted against the fetched record at vendor time -- a mismatch aborts
// rather than silently pinning a different commit.
export const SWE_MANIFEST = [
  { id: "astropy__astropy-14995", repo: "astropy/astropy", base_commit: "b16c7d12ccbc7b2d20364b89fb44285bcbfede54" },
  { id: "django__django-11433", repo: "django/django", base_commit: "21b1d239125f1228e579b1ce8d94d4d5feadd2a6" },
  { id: "sympy__sympy-24213", repo: "sympy/sympy", base_commit: "e8c22f6eac7314be8d92590bfff92ced79ee03e2" },
  { id: "psf__requests-2317", repo: "psf/requests", base_commit: "091991be0da19de9108dbe5e3752917fea3d7fdc" },
  { id: "pytest-dev__pytest-5631", repo: "pytest-dev/pytest", base_commit: "cb828ebe70b4fa35cd5f9a7ee024272237eab351" },
  { id: "django__django-11066", repo: "django/django", base_commit: "4b45b6c8e4d7c9701a332e80d3b1c84209dc36e2" },
  { id: "sympy__sympy-20438", repo: "sympy/sympy", base_commit: "33b47e4bd60e2302e42616141e76285038b724d6" },
  { id: "astropy__astropy-12907", repo: "astropy/astropy", base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607" },
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
  // The gold (solution) patch is NEVER vendored. test_patch IS vendored: it
  // is public upstream, defines what "fixed" means, and is applied only in
  // the verify phase on a clean copy the agent never touches.
  for (const forbidden of ["gold_patch", "solution_patch"]) {
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
    docker_image: `${process.env.SWE_IMAGE_REPO ?? "ghcr.io/harness-arena/swe"}:${instance.instance_id}`,
    workdir: "/repo",
    install_cmd: "",
    test_patch: instance.test_patch ?? "",
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

// Fetches raw instance records for the manifest from the public HuggingFace
// datasets-server API (princeton-nlp/SWE-bench_Verified) and writes one
// <instance_id>.json per instance into outDir. Idempotent.
export async function fetchRawInstances(outDir, manifest = SWE_MANIFEST) {
  mkdirSync(outDir, { recursive: true });
  const wanted = new Map(manifest.map((m) => [m.id, m]));
  const found = new Set();
  let offset = 0;
  const pageSize = 100;

  while (found.size < wanted.size && offset < 2400) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Verified&config=default&split=test&offset=${offset}&length=${pageSize}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HuggingFace datasets-server returned ${res.status} at offset ${offset}`);
    const page = await res.json();
    const rows = page.rows ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const r = row.row;
      if (wanted.has(r.instance_id)) {
        // Strip solution material BEFORE writing to disk (test_patch is kept:
        // it is public upstream verification material, applied only in the
        // verify phase on a clean copy).
        const { gold_patch, patch, ...clean } = r;
        void gold_patch;
        void patch;
        writeFileSync(path.join(outDir, `${r.instance_id}.json`), JSON.stringify(clean, null, 2));
        found.add(r.instance_id);
      }
    }
    offset += pageSize;
    if (page.num_rows_total && offset >= page.num_rows_total) break;
  }

  const missing = [...wanted.keys()].filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`instances not found in SWE-bench Verified: ${missing.join(", ")}`);
  }
  return [...found].sort();
}

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  if (process.argv.includes("--fetch")) {
    const ids = await fetchRawInstances(RAW_DIR);
    console.log(`Fetched ${ids.length} raw instances into ${RAW_DIR}`);
  }
  const ids = vendorFromRawDir(RAW_DIR);
  console.log(`Vendored ${ids.length} SWE tasks into tasks-swe/:`);
  for (const id of ids) console.log(`  ${id}`);
}
