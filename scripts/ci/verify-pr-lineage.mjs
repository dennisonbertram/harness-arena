const CLOSING_KEYWORDS = "close[sd]?|fix(?:e[sd])?|resolve[sd]?";
const CLOSING_ISSUE = new RegExp(`\\b(?:${CLOSING_KEYWORDS})\\s+#(\\d+)\\b`, "gi");

function fail(message) {
  throw new Error(`PR lineage check failed: ${message}`);
}

export function closingIssueNumbers(body) {
  if (typeof body !== "string") return [];

  return [...body.matchAll(CLOSING_ISSUE)].map((match) => Number(match[1]));
}

export async function verifyPullRequestLineage({ body, getIssue }) {
  const issueNumbers = closingIssueNumbers(body);
  if (issueNumbers.length !== 1) {
    fail(`PR body must contain exactly one closing issue (found ${issueNumbers.length}).`);
  }

  if (typeof getIssue !== "function") {
    fail("metadata connector is malformed.");
  }

  const issueNumber = issueNumbers[0];
  let issue;
  try {
    issue = await getIssue(issueNumber);
  } catch {
    fail("Unable to verify PR lineage because GitHub issue metadata could not be read.");
  }

  if (!issue || issue.number !== issueNumber || !issue.parent) {
    fail(`closing issue #${issueNumber} must have a native parent issue.`);
  }

  const { parent } = issue;
  if (!Number.isInteger(parent.number) || !Array.isArray(parent.labels)) {
    fail("GitHub issue metadata is malformed.");
  }

  if (!parent.labels.includes("epic")) {
    fail(`parent issue #${parent.number} must be labeled "epic".`);
  }

  return { issueNumber, parentEpicNumber: parent.number };
}
