function fail(message) {
  throw new Error(`PR lineage check failed: ${message}`);
}

export async function verifyPullRequestLineage({
  baseRepositoryNameWithOwner,
  baseRefName,
  defaultBranchName,
  closingIssueCount,
  closingIssues,
}) {
  if (typeof baseRefName !== "string" || typeof defaultBranchName !== "string") {
    fail("GitHub branch metadata is malformed.");
  }

  if (baseRefName !== defaultBranchName) {
    fail(
      `base branch "${baseRefName}" is not the default branch "${defaultBranchName}". ` +
        "GitHub only populates native closing issue references for the default branch, so lineage cannot be proven.",
    );
  }

  if (!Number.isInteger(closingIssueCount) || !Array.isArray(closingIssues)) {
    fail("GitHub closing issue metadata is malformed.");
  }

  if (closingIssueCount !== 1 || closingIssues.length !== 1) {
    fail(`PR must have exactly one native closing issue reference (found ${closingIssueCount}).`);
  }

  const [issue] = closingIssues;
  if (!issue || !Number.isInteger(issue.number) || !issue.parent) {
    fail("the native closing issue must have a native parent issue.");
  }

  const { parent } = issue;
  if (!Number.isInteger(parent.number) || !Array.isArray(parent.labels)) {
    fail("GitHub issue metadata is malformed.");
  }

  if (!parent.labels.includes("epic")) {
    fail(`parent issue #${parent.number} must be labeled "epic".`);
  }

  if (
    typeof baseRepositoryNameWithOwner !== "string" ||
    typeof issue.repositoryNameWithOwner !== "string" ||
    typeof parent.repositoryNameWithOwner !== "string"
  ) {
    fail("GitHub issue repository metadata is malformed.");
  }

  if (issue.repositoryNameWithOwner !== baseRepositoryNameWithOwner) {
    fail("closing issue repository must match the pull request base repository.");
  }

  if (parent.repositoryNameWithOwner !== baseRepositoryNameWithOwner) {
    fail("parent issue repository must match the pull request base repository.");
  }

  return { issueNumber: issue.number, parentEpicNumber: parent.number };
}
