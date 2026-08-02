import { describe, expect, it } from "vitest";

import { verifyPullRequestLineage } from "./verify-pr-lineage.mjs";

const validIssue = {
  number: 141,
  parent: { number: 139, labels: ["epic"] },
};

async function verify({
  baseRefName = "main",
  defaultBranchName = "main",
  closingIssueCount = 1,
  closingIssues = [validIssue],
} = {}) {
  return verifyPullRequestLineage({
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
