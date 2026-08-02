import { readFile } from "node:fs/promises";

import { verifyPullRequestLineage } from "./verify-pr-lineage.mjs";

const eventPath = process.env.GITHUB_EVENT_PATH;
const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;

if (!eventPath || !token || !repository) {
  throw new Error("PR lineage check requires GITHUB_EVENT_PATH, GITHUB_TOKEN, and GITHUB_REPOSITORY.");
}

const [owner, name] = repository.split("/");
if (!owner || !name) {
  throw new Error("GITHUB_REPOSITORY must be in owner/repository format.");
}

const event = JSON.parse(await readFile(eventPath, "utf8"));
const body = event.pull_request?.body;
if (typeof body !== "string") {
  throw new Error("PR lineage check failed: pull request body is missing or malformed.");
}

async function getIssue(number) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `query PullRequestLineage($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          issue(number: $number) {
            number
            parent {
              number
              labels(first: 100) { nodes { name } }
            }
          }
        }
      }`,
      variables: { owner, name, number },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed with HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (payload.errors?.length || !payload.data?.repository?.issue) {
    throw new Error("GitHub GraphQL response was malformed.");
  }

  const issue = payload.data.repository.issue;
  return {
    number: issue.number,
    parent: issue.parent && {
      number: issue.parent.number,
      labels: issue.parent.labels?.nodes?.map((label) => label.name),
    },
  };
}

const result = await verifyPullRequestLineage({ body, getIssue });
console.log(`Verified closing issue #${result.issueNumber} is a native child of epic #${result.parentEpicNumber}.`);
