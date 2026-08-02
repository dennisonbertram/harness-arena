import { describe, expect, it, vi } from "vitest";

import { createAgentNetworkRuntime } from "./agent-network-runtime";

const ALICE = {
  id: "00000000-0000-0000-0000-000000000101",
  github_id: 101,
  github_login: "alice",
  authenticated_at: "2026-08-03T12:00:00.000Z",
  session_id: "00000000-0000-0000-0000-000000000501",
};
const request = {
  schema_version: "submit_entry.v1" as const,
  competition_id: "competition-1",
  idempotency_key: "entry-key-1",
  entry: { kind: "prompt.v1" as const, agent_name: "solver", prompt: "Find the invariant." },
};

function fixture(entrySaga?: { submit(input: unknown): Promise<unknown> }) {
  const services = {
    repositories: {
      entrants: { upsert: vi.fn() },
      sessions: { create: vi.fn(), isAuthenticated: vi.fn(), touch: vi.fn() },
      memberships: { set: vi.fn() },
    },
    chat: { list: vi.fn(), post: vi.fn() },
  };
  const onQueuedEntry = vi.fn(async () => undefined);
  const runtime = (createAgentNetworkRuntime as any)({
    services,
    storage: { getCompetition: vi.fn() },
    entrySaga,
    onQueuedEntry,
    tokenConfiguration: { issuer: "harness-arena", audience: "harness-arena-mcp", keyId: "key-1" },
  });
  return { runtime, onQueuedEntry };
}

describe("agent network durable entry runtime boundary", () => {
  it("passes only immutable session identity and the exact versioned request to the saga, then dispatches after commit", async () => {
    const entrySaga = { submit: vi.fn().mockResolvedValue({
      replayed: false,
      response: { submission_id: "submission-1", run_id: "run-1", status: "queued" },
    }) };
    const { runtime, onQueuedEntry } = fixture(entrySaga);

    await expect(runtime.submitCompetitionEntry({ actor: ALICE, request })).resolves.toEqual({
      ok: true,
      entry: { submission_id: "submission-1", run_id: "run-1", status: "queued" },
      replayed: false,
    });
    expect(entrySaga.submit).toHaveBeenCalledWith({
      actor: { entrantId: ALICE.id, githubId: ALICE.github_id, githubLogin: ALICE.github_login },
      request,
    });
    expect(onQueuedEntry).toHaveBeenCalledWith({ submission_id: "submission-1", run_id: "run-1", replayed: false });
    expect(entrySaga.submit.mock.invocationCallOrder[0]).toBeLessThan(onQueuedEntry.mock.invocationCallOrder[0]);
  });

  it("fails closed when unwired and maps durable public errors without dispatch", async () => {
    const absent = fixture();
    await expect(absent.runtime.submitCompetitionEntry({ actor: ALICE, request }))
      .resolves.toEqual({ ok: false, error: { code: "entries_unavailable" } });

    for (const [source, code] of [
      ["COMPETITION_NOT_FOUND", "competition_not_found"],
      ["COMPETITION_CLOSED", "competition_closed"],
      ["IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST", "idempotency_conflict"],
      ["ENTRY_RECONCILIATION_REQUIRED", "reconciliation_required"],
    ] as const) {
      const entrySaga = { submit: vi.fn().mockRejectedValue(Object.assign(new Error(source), { code: source })) };
      const subject = fixture(entrySaga);
      await expect(subject.runtime.submitCompetitionEntry({ actor: ALICE, request }))
        .resolves.toEqual({ ok: false, error: { code } });
      expect(subject.onQueuedEntry).not.toHaveBeenCalled();
    }
  });

  it("does not dispatch rejected entries and redacts unknown saga failures", async () => {
    const rejected = fixture({ submit: vi.fn().mockResolvedValue({ replayed: false, response: { submission_id: "submission-1", status: "rejected" } }) });
    await expect(rejected.runtime.submitCompetitionEntry({ actor: ALICE, request })).resolves.toMatchObject({
      ok: true, entry: { status: "rejected" }, replayed: false,
    });
    expect(rejected.onQueuedEntry).not.toHaveBeenCalled();

    const unknown = fixture({ submit: vi.fn().mockRejectedValue(new Error("postgres://secret and prompt text")) });
    await expect(unknown.runtime.submitCompetitionEntry({ actor: ALICE, request }))
      .resolves.toEqual({ ok: false, error: { code: "entries_unavailable" } });
  });
});
