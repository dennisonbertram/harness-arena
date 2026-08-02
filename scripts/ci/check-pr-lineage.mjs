import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { verifyPullRequestLineage } from "./verify-pr-lineage.mjs";

const GRAPHQL_URL = "https://api.github.com/graphql";

const LINEAGE_QUERY = `query PullRequestLineage($owner: String!, $name: String!, $number: Int!, $issueNumber: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef { name }
    pullRequest(number: $number) {
      number
      closingIssuesReferences(first: 2) {
        totalCount
        nodes {
          number
          repository { nameWithOwner }
          parent {
            number
            repository { nameWithOwner }
            labels(first: 100) { nodes { name } }
          }
        }
      }
    }
    issue(number: $issueNumber) {
      number
      repository { nameWithOwner }
      parent {
        number
        repository { nameWithOwner }
        labels(first: 100) { nodes { name } }
      }
    }
  }
}`;

function fail(message) {
  throw new Error(`PR lineage check failed: ${message}`);
}

export function parseDevelopmentClosingIssue(body) {
  if (typeof body !== "string") {
    fail(
      "dev PR body must contain exactly one entire canonical local Closes #N reference " +
        "(exactly one local Closes #N).",
    );
  }

  const candidates = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/i.test(line));
  const match = candidates.length === 1 ? /^Closes #([1-9]\d*)$/.exec(candidates[0]) : null;
  if (!match) {
    fail(
      "dev PR body must contain exactly one entire canonical local Closes #N reference " +
        "(exactly one local Closes #N); extra, cross-repository, and malformed closing directives are not allowed.",
    );
  }

  return Number(match[1]);
}

function repositoryParts(repository) {
  if (typeof repository !== "string") {
    throw new Error("GITHUB_REPOSITORY must be in owner/repository format.");
  }

  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error("GITHUB_REPOSITORY must be in owner/repository format.");
  }

  return parts;
}

export async function checkPullRequestLineage({ event, token, repository, fetchImpl = fetch }) {
  const [owner, name] = repositoryParts(repository);
  const number = event?.pull_request?.number;
  const baseRefName = event?.pull_request?.base?.ref;
  if (!Number.isInteger(number) || typeof baseRefName !== "string") {
    throw new Error("PR lineage check failed: pull request event metadata is missing or malformed.");
  }

  const developmentIssueNumber = baseRefName === "dev" ? parseDevelopmentClosingIssue(event.pull_request.body) : 1;

  let response;
  try {
    response = await fetchImpl(GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: LINEAGE_QUERY,
        variables: { owner, name, number, issueNumber: developmentIssueNumber },
      }),
    });
  } catch {
    throw new Error("GitHub GraphQL request failed before a response was received.");
  }

  if (!response?.ok) {
    throw new Error(`GitHub GraphQL request failed with HTTP ${response?.status ?? "unknown"}.`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("GitHub GraphQL response was malformed.");
  }

  const graphRepository = payload?.data?.repository;
  const pullRequest = graphRepository?.pullRequest;
  const references = pullRequest?.closingIssuesReferences;
  if (
    payload?.errors?.length ||
    graphRepository?.nameWithOwner !== repository ||
    !graphRepository?.defaultBranchRef ||
    pullRequest?.number !== number ||
    !references
  ) {
    throw new Error("GitHub GraphQL response was malformed.");
  }

  const closingIssues = references.nodes?.map((issue) => ({
    number: issue?.number,
    repositoryNameWithOwner: issue?.repository?.nameWithOwner,
    parent:
      issue?.parent === null
        ? null
        : {
            number: issue?.parent?.number,
            repositoryNameWithOwner: issue?.parent?.repository?.nameWithOwner,
            labels: issue?.parent?.labels?.nodes?.map((label) => label?.name),
          },
  }));

  if (baseRefName === "dev") {
    const issue = graphRepository.issue;
    if (!issue) {
      throw new Error("GitHub GraphQL response was malformed.");
    }
    if (issue.number !== developmentIssueNumber) {
      fail(`GitHub issue #${issue.number} does not match parsed Closes #${developmentIssueNumber}.`);
    }

    return verifyPullRequestLineage({
      baseRepositoryNameWithOwner: graphRepository.nameWithOwner,
      baseRefName: graphRepository.defaultBranchRef.name,
      defaultBranchName: graphRepository.defaultBranchRef.name,
      closingIssueCount: 1,
      closingIssues: [
        {
          number: issue.number,
          repositoryNameWithOwner: issue.repository?.nameWithOwner,
          parent:
            issue.parent === null
              ? null
              : {
                  number: issue.parent?.number,
                  repositoryNameWithOwner: issue.parent?.repository?.nameWithOwner,
                  labels: issue.parent?.labels?.nodes?.map((label) => label?.name),
                },
        },
      ],
    });
  }

  return verifyPullRequestLineage({
    baseRepositoryNameWithOwner: graphRepository.nameWithOwner,
    baseRefName,
    defaultBranchName: graphRepository.defaultBranchRef.name,
    closingIssueCount: references.totalCount,
    closingIssues,
  });
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!eventPath || !token || !repository) {
    throw new Error("PR lineage check requires GITHUB_EVENT_PATH, GITHUB_TOKEN, and GITHUB_REPOSITORY.");
  }

  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const result = await checkPullRequestLineage({ event, token, repository });
  console.log(`Verified closing issue #${result.issueNumber} is a native child of epic #${result.parentEpicNumber}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
