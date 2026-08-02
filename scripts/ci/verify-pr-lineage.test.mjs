import { describe, expect, it } from "vitest";

import { verifyPullRequestLineage } from "./verify-pr-lineage.mjs";

const validIssue = {
  number: 141,
  parent: { number: 139, labels: ["epic"] },
};

async function verify(body, issues = new Map([[141, validIssue]])) {
  return verifyPullRequestLineage({
    body,
    getIssue: async (number) => issues.get(number),
  });
}

describe("verifyPullRequestLineage", () => {
  it("rejects a PR with no closing issue", async () => {
    await expect(verify("Parent Epic #139")).rejects.toThrow("exactly one closing issue");
  });

  it("rejects a PR that closes multiple issues", async () => {
    await expect(verify("Closes #141\nFixes #142")).rejects.toThrow("exactly one closing issue");
  });

  it("rejects a linked implementation issue without a native parent", async () => {
    await expect(verify("Closes #141", new Map([[141, { number: 141, parent: null }]]))).rejects.toThrow(
      "native parent",
    );
  });

  it("rejects a parent that is not labeled epic", async () => {
    await expect(
      verify("Closes #141", new Map([[141, { number: 141, parent: { number: 139, labels: ["type:feature"] } }]])),
    ).rejects.toThrow('labeled "epic"');
  });

  it("accepts one closing issue that is a native child of an epic", async () => {
    await expect(verify("Closes #141\n\nParent Epic #139")).resolves.toEqual({
      issueNumber: 141,
      parentEpicNumber: 139,
    });
  });

  it("fails closed when the metadata API returns malformed data", async () => {
    await expect(verify("Closes #141", new Map([[141, { number: 141, parent: { labels: "epic" } }]]))).rejects.toThrow(
      "malformed",
    );
  });

  it("fails closed when the metadata API fails", async () => {
    await expect(
      verifyPullRequestLineage({
        body: "Closes #141",
        getIssue: async () => {
          throw new Error("GitHub API unavailable");
        },
      }),
    ).rejects.toThrow("Unable to verify PR lineage");
  });
});
