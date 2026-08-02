#!/usr/bin/env node
// Verify that Vercel deployment metadata describes an exact, clean Git source.
// Usage: node scripts/ops/check-deploy-provenance.mjs deployment.json --branch main --sha <sha>

import { readFile } from "node:fs/promises";

function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function deploymentProvenance(deployment = {}) {
  const meta = deployment?.meta ?? deployment?.metadata ?? {};
  return {
    branch: asString(meta.githubCommitRef ?? meta.gitBranch ?? meta.branch),
    sha: asString(meta.githubCommitSha ?? meta.gitCommitSha ?? meta.sha),
    gitDirty: asString(meta.gitDirty),
  };
}

export function checkDeployProvenance({ deployment, expected = {} } = {}) {
  const actual = deploymentProvenance(deployment);
  const branch = asString(expected.branch);
  const sha = asString(expected.sha);
  const errors = [];

  if (!branch) errors.push("expected branch is required");
  if (!sha) errors.push("expected sha is required");
  if (!actual.branch) errors.push("missing branch metadata");
  if (!actual.sha) errors.push("missing sha metadata");
  if (actual.gitDirty === "1") errors.push("gitDirty must not be 1");
  if (branch && actual.branch && actual.branch !== branch) {
    errors.push(`branch must equal ${branch} (received ${actual.branch})`);
  }
  if (sha && actual.sha && actual.sha !== sha) {
    errors.push(`sha must equal ${sha} (received ${actual.sha})`);
  }

  return { ok: errors.length === 0, errors, actual };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("usage: check-deploy-provenance.mjs deployment.json --branch main --sha <sha>");
    process.exitCode = 2;
  } else {
    const deployment = JSON.parse(await readFile(inputPath, "utf8"));
    const result = checkDeployProvenance({
      deployment,
      expected: { branch: option("--branch"), sha: option("--sha") },
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
}
