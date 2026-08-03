import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const checker = await readFile(new URL("./check-pr-lineage.mjs", import.meta.url), "utf8");
const processDocs = [
  ["AGENTS.md", await readFile(new URL("../../AGENTS.md", import.meta.url), "utf8")],
  ["README.md", await readFile(new URL("../../README.md", import.meta.url), "utf8")],
  ["pull request template", await readFile(new URL("../../.github/PULL_REQUEST_TEMPLATE.md", import.meta.url), "utf8")],
];
const developmentRunbook = await readFile(
  new URL("../../docs/runbooks/development-environment.md", import.meta.url),
  "utf8",
);
const localRunbook = await readFile(new URL("../../docs/runbooks/local-init.md", import.meta.url), "utf8");
const envExample = await readFile(new URL("../../.env.example", import.meta.url), "utf8");

const CHECKOUT_SHA = "11d5960a326750d5838078e36cf38b85af677262";
const SETUP_NODE_SHA = "49933ea5288caeca8642d1e84afbd3f7d6820020";
const PNPM_SETUP_SHA = "b906affcce14559ad1aafd4ab0e942779e9f58b1";

describe("CI workflow contract", () => {
  it("routes both protected PR bases through the checked-in lineage wrapper", () => {
    expect(workflow).toMatch(/pull_request:[\s\S]*?branches:[\s\S]*?- main[\s\S]*?- dev/);
    expect(workflow).toContain("node scripts/ci/check-pr-lineage.mjs");
    expect(checker).toContain('baseRefName === "dev"');
    expect(checker).toContain("closingIssuesReferences");
  });

  it("runs on every PR activity that can change code, draft state, or lineage metadata", () => {
    for (const type of ["opened", "synchronize", "reopened", "ready_for_review", "edited", "converted_to_draft"]) {
      expect(workflow).toMatch(new RegExp(`\\n\\s+- ${type}\\n`));
    }
  });

  it("cancels older runs by PR number so metadata edits at the same SHA cannot race", () => {
    expect(workflow).toMatch(/concurrency:\s*\n\s+group:.*pull_request\.number/);
    expect(workflow).toMatch(/cancel-in-progress:\s*true/);
    expect(workflow).not.toMatch(/concurrency:[\s\S]{0,200}github\.sha/);
  });

  it("uses deny-by-default permissions and grants only job-specific read scopes", () => {
    expect(workflow).toMatch(/^permissions:\s*\{\}\s*$/m);
    expect(workflow).toMatch(/build:[\s\S]*?permissions:\s*\n\s+contents:\s*read[\s\S]*?runs-on:/);
    expect(workflow).toMatch(
      /pr-lineage:[\s\S]*?permissions:\s*\n\s+contents:\s*read\s*\n\s+issues:\s*read\s*\n\s+pull-requests:\s*read/,
    );
  });

  it("pins every third-party action to the reviewed full SHA", () => {
    expect(workflow).toContain(`actions/checkout@${CHECKOUT_SHA}`);
    expect(workflow).toContain(`actions/setup-node@${SETUP_NODE_SHA}`);
    expect(workflow).toContain(`pnpm/action-setup@${PNPM_SETUP_SHA}`);
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@v\d+/);
  });

  it("prevents checkout from persisting GitHub credentials", () => {
    const checkoutSteps = [...workflow.matchAll(/uses:\s+actions\/checkout@[^\n]+\n([\s\S]*?)(?=\n\s+- (?:uses|run):)/g)];
    expect(checkoutSteps).toHaveLength(2);
    for (const [, config] of checkoutSteps) {
      expect(config).toMatch(/with:\s*\n\s+persist-credentials:\s*false/);
    }
  });
});

describe("lineage documentation contract", () => {
  it.each(processDocs)("keeps %s aligned with branch-specific checker semantics", (_name, document) => {
    expect(document).toMatch(/all work[\s\S]{0,120}Epic[\s\S]{0,120}native GitHub (?:subissue|child)/i);
    expect(document).toMatch(/`main` PRs[\s\S]{0,160}native `closingIssuesReferences`/i);
    expect(document).toMatch(/`dev` PRs[\s\S]{0,180}exactly one standalone same-repository `Closes #N`/i);
    expect(document).toMatch(/issue is queried[\s\S]{0,160}native child[\s\S]{0,160}same-repository Epic/i);
    expect(document).toMatch(/cross-repository, malformed, or extra closing references fail/i);
    expect(document).toMatch(
      /Development-only work stays on `dev` and must never be retargeted to or merged into `main` without explicit future approval/i,
    );
    expect(document).not.toMatch(/`dev` PRs? intentionally fail/i);
    expect(document).not.toMatch(/retarget it to `main`/i);
  });
});

describe("development runbook safety boundary", () => {
  it("requires read-only live evidence while forbidding every live mutation path", () => {
    expect(developmentRunbook).toMatch(
      /read-only inspection of live identifiers, routing, and deployment metadata is required/i,
    );
    expect(developmentRunbook).toMatch(
      /forbids all live mutations, deploys, promotions, rollbacks, alias changes, environment changes, store changes, data changes, credential value reads, and mutating application access/i,
    );
    expect(developmentRunbook).not.toMatch(/must never be used to[\s\S]{0,80}inspect/i);
  });

  it("documents the required public Development callback without publishing a live or localhost example", () => {
    expect(envExample).toMatch(/^CALLBACK_BASE=$/m);
    expect(envExample).toMatch(/CALLBACK_BASE[\s\S]{0,240}required[\s\S]{0,240}canonical[\s\S]{0,240}publicly reachable HTTPS/i);
    expect(envExample).toMatch(/Vercel Sandbox/i);
    expect(envExample).not.toMatch(/^CALLBACK_BASE=https?:\/\/.+/m);
    expect(developmentRunbook).toMatch(
      /CALLBACK_BASE[\s\S]{0,320}required[\s\S]{0,320}canonical[\s\S]{0,320}publicly reachable HTTPS[\s\S]{0,320}Vercel Sandbox/i,
    );
    expect(localRunbook).toMatch(/localhost[\s\S]{0,240}not reachable from Vercel Sandbox/i);
  });
});
