import { describe, expect, it, vi } from "vitest";
import { createInMemoryAgentNetworkData } from "../agent-network-data";
import {
  createCompetitionEntryService,
  parseSubmitEntryRequest,
  projectCompetitionResults,
  projectPublicCompetitions,
} from "./index";

const liveCompetition = {
  id: "comp-live",
  arena: "harness-arena",
  harness: "pi",
  model: "zai/glm-5.2",
  prize_amount_usd: null,
  prize_cadence: null,
  status: "live" as const,
  created_at: "2026-08-01T00:00:00.000Z",
};

const board = {
  baseline: null,
  baselineState: "none" as const,
  ranked: [
    {
      submissionId: "submission-1",
      runId: "run-1",
      rank: 1,
      tied: false,
      tasksPassed: 8,
      totalTasks: 10,
      totalCostUsd: 0.42,
      billedCostUsd: 0.37,
      pricingVersion: "pricing-v1",
      submittedAt: "2026-08-02T00:00:00.000Z",
      githubLogin: "octo",
      // Deliberately hostile extra fields: neither prompts nor traces can
      // become public just because an upstream joined record contains them.
      prompt: "private entrant strategy",
      trace_blob_url: "https://private.example/trace.jsonl",
    },
  ],
  belowBaseline: [],
  unpriced: 1,
  pending: 0,
  pendingRunIds: [],
  pendingRows: [],
};

const request = {
  schema_version: "submit_entry.v1",
  competition_id: "comp-live",
  idempotency_key: "client-key-001",
  entry: {
    kind: "prompt.v1",
    agent_name: "Octo Agent",
    prompt: "Improve the harness while preserving compatibility.",
  },
};

describe("competition entries contract", () => {
  it("projects public competition listing and selected results from board-shaped inputs without prompt or trace data", () => {
    expect(projectPublicCompetitions([liveCompetition])).toEqual([
      expect.objectContaining({
        id: "comp-live",
        arena: "harness-arena",
        harness: "pi",
        model: "zai/glm-5.2",
        status: "live",
      }),
    ]);

    const result = projectCompetitionResults({ competition: liveCompetition, board });
    expect(result).toMatchObject({
      competition: expect.objectContaining({ id: "comp-live", status: "live" }),
      ranked: [expect.objectContaining({ submissionId: "submission-1", runId: "run-1", rank: 1 })],
      baselineState: "none",
      unpriced: 1,
    });
    expect(result.ranked[0]).not.toHaveProperty("prompt");
    expect(result.ranked[0]).not.toHaveProperty("trace_blob_url");
    expect(result.ranked[0]).toMatchObject({ totalCostUsd: 0.42, billedCostUsd: 0.37, pricingVersion: "pricing-v1" });
    expect(JSON.stringify(result)).not.toContain("private entrant strategy");
    expect(JSON.stringify(result)).not.toContain("private.example/trace.jsonl");
  });

  it("accepts the versioned prompt.v1 envelope while rejecting unknown future entry discriminants", () => {
    expect(parseSubmitEntryRequest(request)).toEqual(request);
    expect(() =>
      parseSubmitEntryRequest({ ...request, entry: { kind: "artifact.v1", artifact_url: "https://example.test/a" } }),
    ).toThrow(/entry|kind|discrimin/i);
  });

  it("does not accept actor identity in the client envelope", () => {
    expect(() => parseSubmitEntryRequest({ ...request, actor_id: "github:attacker" })).toThrow();
  });

  it("derives the submitter from the server actor and rejects a closed competition before it reserves an operation", async () => {
    const createPromptSubmission = vi.fn(async (input) => ({ submissionId: `submission-for-${input.actor.githubId}` }));
    const service = createCompetitionEntryService({
      data: createInMemoryAgentNetworkData(),
      getCompetition: async () => ({ ...liveCompetition, status: "closed" as const }),
      createPromptSubmission,
    });

    await expect(
      service.submitEntry({ actor: { githubId: 42, githubLogin: "server-octo" }, request }),
    ).rejects.toMatchObject({ code: "COMPETITION_CLOSED" });
    expect(createPromptSubmission).not.toHaveBeenCalled();
  });

  it("wires the exact versioned request to the operation ledger so matching retries replay one submission", async () => {
    const createPromptSubmission = vi.fn(async (input) => ({
      submissionId: `submission-for-${input.actor.githubId}`,
      githubLogin: input.actor.githubLogin,
      promptKind: input.entry.kind,
    }));
    const service = createCompetitionEntryService({
      data: createInMemoryAgentNetworkData(),
      getCompetition: async () => liveCompetition,
      createPromptSubmission,
    });
    const actor = { githubId: 42, githubLogin: "server-octo" };

    const first = await service.submitEntry({ actor, request });
    const replay = await service.submitEntry({ actor, request: { ...request, entry: { ...request.entry } } });

    expect(first).toMatchObject({ replayed: false, response: { githubLogin: "server-octo", promptKind: "prompt.v1" } });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(createPromptSubmission).toHaveBeenCalledTimes(1);
    expect(createPromptSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ actor, competition: liveCompetition, entry: request.entry }),
    );
  });

  it("fails closed when the same client key changes the versioned entry payload", async () => {
    const createPromptSubmission = vi.fn(async () => ({ submissionId: "submission-1" }));
    const service = createCompetitionEntryService({
      data: createInMemoryAgentNetworkData(),
      getCompetition: async () => liveCompetition,
      createPromptSubmission,
    });
    const actor = { githubId: 42, githubLogin: "server-octo" };

    await service.submitEntry({ actor, request });
    await expect(
      service.submitEntry({ actor, request: { ...request, entry: { ...request.entry, prompt: "altered payload" } } }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" });
    expect(createPromptSubmission).toHaveBeenCalledTimes(1);
  });
});
