import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

const CHECKOUT_SHA = "11d5960a326750d5838078e36cf38b85af677262";
const SETUP_NODE_SHA = "49933ea5288caeca8642d1e84afbd3f7d6820020";
const PNPM_SETUP_SHA = "b906affcce14559ad1aafd4ab0e942779e9f58b1";

describe("CI workflow contract", () => {
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
    expect(workflow).toMatch(/mcp:[\s\S]*?permissions:\s*\n\s+contents:\s*read[\s\S]*?runs-on:/);
  });

  it("pins every third-party action to the reviewed full SHA", () => {
    expect(workflow).toContain(`actions/checkout@${CHECKOUT_SHA}`);
    expect(workflow).toContain(`actions/setup-node@${SETUP_NODE_SHA}`);
    expect(workflow).toContain(`pnpm/action-setup@${PNPM_SETUP_SHA}`);
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@v\d+/);
  });

  it("prevents checkout from persisting GitHub credentials", () => {
    const checkoutSteps = [...workflow.matchAll(/uses:\s+actions\/checkout@[^\n]+\n([\s\S]*?)(?=\n\s+- (?:uses|run):)/g)];
    const runnerJobs = [...workflow.matchAll(/^\s{4}runs-on:\s*ubuntu-latest\s*$/gm)];
    expect(checkoutSteps).toHaveLength(runnerJobs.length);
    for (const [, config] of checkoutSteps) {
      expect(config).toMatch(/with:\s*\n\s+persist-credentials:\s*false/);
    }
  });
});
