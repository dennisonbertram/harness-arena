import { describe, expect, it, vi } from "vitest";

import * as wrapper from "./check-pr-lineage.mjs";

const event = {
  pull_request: {
    number: 149,
    base: { ref: "main" },
  },
};

const repositoryNameWithOwner = "dennisonbertram/harness-arena";

const validPayload = {
  data: {
    repository: {
      nameWithOwner: repositoryNameWithOwner,
      defaultBranchRef: { name: "main" },
      pullRequest: {
        number: 149,
        closingIssuesReferences: {
          totalCount: 1,
          nodes: [
            {
              number: 141,
              repository: { nameWithOwner: repositoryNameWithOwner },
              parent: {
                number: 139,
                repository: { nameWithOwner: repositoryNameWithOwner },
                labels: { nodes: [{ name: "epic" }] },
              },
            },
          ],
        },
      },
    },
  },
};

function response(payload = validPayload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

function checker() {
  expect(wrapper.checkPullRequestLineage, "wrapper must export a testable end-to-end checker").toBeTypeOf("function");
  return wrapper.checkPullRequestLineage;
}

describe("checkPullRequestLineage", () => {
  it("queries native closingIssuesReferences for the event PR and validates its Epic parent", async () => {
    const fetchImpl = vi.fn(async () => response());

    await expect(
      checker()({ event, token: "test-token", repository: "dennisonbertram/harness-arena", fetchImpl }),
    ).resolves.toEqual({ issueNumber: 141, parentEpicNumber: 139 });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.github.com/graphql");
    const request = JSON.parse(options.body);
    expect(request.query).toContain("closingIssuesReferences");
    expect(request.variables).toEqual({ owner: "dennisonbertram", name: "harness-arena", number: 149 });
  });

  it("rejects a foreign closing issue and foreign Epic from the GraphQL fixture", async () => {
    const payload = structuredClone(validPayload);
    const [issue] = payload.data.repository.pullRequest.closingIssuesReferences.nodes;
    issue.repository.nameWithOwner = "attacker/foreign-repo";
    issue.parent.repository.nameWithOwner = "attacker/foreign-repo";

    await expect(
      checker()({
        event,
        token: "test-token",
        repository: repositoryNameWithOwner,
        fetchImpl: async () => response(payload),
      }),
    ).rejects.toThrow("closing issue repository must match the pull request base repository");
  });

  it("rejects a base-repository closing issue with a foreign Epic from the GraphQL fixture", async () => {
    const payload = structuredClone(validPayload);
    const [issue] = payload.data.repository.pullRequest.closingIssuesReferences.nodes;
    issue.parent.repository.nameWithOwner = "attacker/foreign-repo";

    await expect(
      checker()({
        event,
        token: "test-token",
        repository: repositoryNameWithOwner,
        fetchImpl: async () => response(payload),
      }),
    ).rejects.toThrow("parent issue repository must match the pull request base repository");
  });

  it("fails closed when native metadata reports multiple closing issues", async () => {
    const payload = structuredClone(validPayload);
    payload.data.repository.pullRequest.closingIssuesReferences.totalCount = 2;
    payload.data.repository.pullRequest.closingIssuesReferences.nodes.push({
      number: 142,
      repository: { nameWithOwner: repositoryNameWithOwner },
      parent: {
        number: 139,
        repository: { nameWithOwner: repositoryNameWithOwner },
        labels: { nodes: [{ name: "epic" }] },
      },
    });

    await expect(
      checker()({
        event,
        token: "test-token",
        repository: "dennisonbertram/harness-arena",
        fetchImpl: async () => response(payload),
      }),
    ).rejects.toThrow("exactly one native closing issue");
  });

  it("fails closed with explicit semantics for dev targets", async () => {
    const devEvent = structuredClone(event);
    devEvent.pull_request.base.ref = "dev";
    const payload = structuredClone(validPayload);
    payload.data.repository.pullRequest.closingIssuesReferences = { totalCount: 0, nodes: [] };

    await expect(
      checker()({
        event: devEvent,
        token: "test-token",
        repository: "dennisonbertram/harness-arena",
        fetchImpl: async () => response(payload),
      }),
    ).rejects.toThrow("GitHub only populates native closing issue references for the default branch");
  });

  it("fails closed when GitHub returns an HTTP error", async () => {
    await expect(
      checker()({
        event,
        token: "test-token",
        repository: "dennisonbertram/harness-arena",
        fetchImpl: async () => response({}, { ok: false, status: 503 }),
      }),
    ).rejects.toThrow("HTTP 503");
  });

  it("fails closed when the GraphQL fixture is malformed", async () => {
    await expect(
      checker()({
        event,
        token: "test-token",
        repository: "dennisonbertram/harness-arena",
        fetchImpl: async () => response({ data: { repository: null } }),
      }),
    ).rejects.toThrow("malformed");
  });
});
