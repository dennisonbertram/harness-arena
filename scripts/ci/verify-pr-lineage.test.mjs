import { describe, expect, it } from "vitest";

import { verifyPullRequestLineage } from "./verify-pr-lineage.mjs";

const repositoryNameWithOwner = "dennisonbertram/harness-arena";

const validIssue = {
  number: 141,
  repositoryNameWithOwner,
  parent: { number: 139, repositoryNameWithOwner, labels: ["epic"] },
};

async function verify({
  baseRefName = "main",
  defaultBranchName = "main",
  closingIssueCount = 1,
  closingIssues = [validIssue],
} = {}) {
  return verifyPullRequestLineage({
    baseRepositoryNameWithOwner: repositoryNameWithOwner,
    baseRefName,
    defaultBranchName,
    closingIssueCount,
    closingIssues,
  });
}

describe("verifyPullRequestLineage", () => {
  it("rejects a PR with no native closing issue reference", async () => {
    await expect(verify({ closingIssueCount: 0, closingIssues: [] })).rejects.toThrow(
      "exactly one native closing issue",
    );
  });

  it("rejects a PR with multiple native closing issue references", async () => {
    await expect(
      verify({
        closingIssueCount: 2,
        closingIssues: [validIssue, { number: 142, parent: { number: 139, labels: ["epic"] } }],
      }),
    ).rejects.toThrow("exactly one native closing issue");
  });

  it("rejects a linked implementation issue without a native parent", async () => {
    await expect(verify({ closingIssues: [{ number: 141, parent: null }] })).rejects.toThrow("native parent");
  });

  it("rejects a parent that is not labeled epic", async () => {
    await expect(
      verify({ closingIssues: [{ number: 141, parent: { number: 139, labels: ["type:feature"] } }] }),
    ).rejects.toThrow('labeled "epic"');
  });

  it("accepts exactly one native closing issue that is a child of an epic", async () => {
    await expect(verify()).resolves.toEqual({
      issueNumber: 141,
      parentEpicNumber: 139,
    });
  });

  it("rejects a closing issue and Epic from a foreign repository", async () => {
    await expect(
      verify({
        closingIssues: [
          {
            number: 141,
            repositoryNameWithOwner: "attacker/foreign-repo",
            parent: {
              number: 139,
              repositoryNameWithOwner: "attacker/foreign-repo",
              labels: ["epic"],
            },
          },
        ],
      }),
    ).rejects.toThrow("closing issue repository must match the pull request base repository");
  });

  it("rejects a base-repository closing issue whose Epic is foreign", async () => {
    await expect(
      verify({
        closingIssues: [
          {
            ...validIssue,
            parent: {
              ...validIssue.parent,
              repositoryNameWithOwner: "attacker/foreign-repo",
            },
          },
        ],
      }),
    ).rejects.toThrow("parent issue repository must match the pull request base repository");
  });

  it("fails closed when the native issue metadata is malformed", async () => {
    await expect(verify({ closingIssues: [{ number: 141, parent: { labels: "epic" } }] })).rejects.toThrow(
      "malformed",
    );
  });

  it("fails closed for a non-default target because GitHub cannot prove native closing references", async () => {
    await expect(verify({ baseRefName: "dev" })).rejects.toThrow(
      "GitHub only populates native closing issue references for the default branch",
    );
  });
});
