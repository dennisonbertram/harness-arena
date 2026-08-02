import { describe, expect, it } from "vitest";

import { checkDeployProvenance } from "./check-deploy-provenance.mjs";

const expected = {
  branch: "main",
  sha: "8b86c085b94cae9515179ee4592de93123484947",
};

describe("checkDeployProvenance", () => {
  it("fails closed when source metadata is missing, dirty, on another branch, or at another SHA", () => {
    const result = checkDeployProvenance({
      deployment: {
        meta: {
          githubCommitRef: "codex/direct-run-links",
          githubCommitSha: "97a39e73885115649876ba526912f1370017387f",
          gitDirty: "1",
        },
      },
      expected,
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        "gitDirty must not be 1",
        "branch must equal main (received codex/direct-run-links)",
        "sha must equal 8b86c085b94cae9515179ee4592de93123484947 (received 97a39e73885115649876ba526912f1370017387f)",
      ],
      actual: {
        branch: "codex/direct-run-links",
        sha: "97a39e73885115649876ba526912f1370017387f",
        gitDirty: "1",
      },
    });

    expect(checkDeployProvenance({ deployment: {}, expected })).toEqual({
      ok: false,
      errors: [
        "missing branch metadata",
        "missing sha metadata",
      ],
      actual: { branch: undefined, sha: undefined, gitDirty: undefined },
    });
  });

  it("accepts an exact clean main deployment", () => {
    expect(checkDeployProvenance({
      deployment: {
        meta: {
          githubCommitRef: expected.branch,
          githubCommitSha: expected.sha,
        },
      },
      expected,
    })).toEqual({
      ok: true,
      errors: [],
      actual: { branch: expected.branch, sha: expected.sha, gitDirty: undefined },
    });
  });
});
