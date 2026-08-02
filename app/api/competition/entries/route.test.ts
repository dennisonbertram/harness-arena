import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  authenticateAgentSession: vi.fn(),
  submitCompetitionEntry: vi.fn(),
}));

vi.mock("@/lib/agent-network-runtime", () => ({ getAgentNetworkRuntime: () => runtime }));

import { POST } from "./route";

const actor = {
  id: "00000000-0000-0000-0000-000000000101",
  github_id: 101,
  github_login: "trusted-octocat",
  authenticated_at: "2026-08-03T00:00:00.000Z",
  session_id: "session-101",
};

const body = {
  schema_version: "submit_entry.v1",
  competition_id: "live-cup",
  idempotency_key: "entry-key-1",
  entry: { kind: "prompt.v1", agent_name: "solver", prompt: "Find the invariant." },
};

const request = (value: unknown = body) => new NextRequest("http://localhost/api/competition/entries", {
  method: "POST",
  headers: { authorization: "Bearer scoped-session", "content-type": "application/json" },
  body: JSON.stringify(value),
});

describe("POST /api/competition/entries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.authenticateAgentSession.mockResolvedValue({ ok: true, actor });
    runtime.submitCompetitionEntry.mockResolvedValue({
      ok: true,
      entry: { submission_id: "submission-1", run_id: "run-1", status: "queued" },
    });
  });

  it("accepts only submit_entry.v1 under competitions:write and gives the durable saga the session identity", async () => {
    const response = await POST(request());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ entry: { submission_id: "submission-1", run_id: "run-1", status: "queued" } });
    expect(runtime.authenticateAgentSession).toHaveBeenCalledWith(expect.any(NextRequest), { requiredScopes: ["competitions:write"] });
    expect(runtime.submitCompetitionEntry).toHaveBeenCalledTimes(1);
    expect(runtime.submitCompetitionEntry).toHaveBeenCalledWith({ actor, request: body });
  });

  it("never takes entrant or GitHub identity from the request body", async () => {
    const tampered = {
      ...body,
      github_id: 999,
      github_login: "attacker",
      entrant_id: "attacker-private-id",
    };

    const response = await POST(request(tampered));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "invalid_body" } });
    expect(runtime.submitCompetitionEntry).not.toHaveBeenCalled();
  });

  it("replays the same idempotency key without creating another durable operation", async () => {
    const replay = { submission_id: "submission-1", run_id: "run-1", status: "queued" };
    runtime.submitCompetitionEntry.mockResolvedValue({ ok: true, entry: replay });

    const first = await POST(request());
    const second = await POST(request({ ...body, entry: { ...body.entry } }));

    await expect(first.json()).resolves.toEqual({ entry: replay });
    await expect(second.json()).resolves.toEqual({ entry: replay });
    expect(runtime.submitCompetitionEntry).toHaveBeenNthCalledWith(1, { actor, request: body });
    expect(runtime.submitCompetitionEntry).toHaveBeenNthCalledWith(2, { actor, request: { ...body, entry: { ...body.entry } } });
  });

  it("maps closed and unknown competitions plus changed-key conflicts to stable public errors", async () => {
    runtime.submitCompetitionEntry.mockResolvedValueOnce({ ok: false, error: { code: "competition_not_found" } });
    const missing = await POST(request());
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: { code: "competition_not_found" } });

    runtime.submitCompetitionEntry.mockResolvedValueOnce({ ok: false, error: { code: "competition_closed" } });
    const closed = await POST(request());
    expect(closed.status).toBe(409);
    await expect(closed.json()).resolves.toEqual({ error: { code: "competition_closed" } });

    runtime.submitCompetitionEntry.mockResolvedValueOnce({ ok: false, error: { code: "idempotency_conflict" } });
    const changedKey = await POST(request({ ...body, entry: { ...body.entry, prompt: "different" } }));
    expect(changedKey.status).toBe(409);
    await expect(changedKey.json()).resolves.toEqual({ error: { code: "idempotency_conflict" } });
  });

  it("fails ambiguous judge recovery closed with 503 and does not retry the saga in the request", async () => {
    runtime.submitCompetitionEntry.mockResolvedValueOnce({ ok: false, error: { code: "reconciliation_required" } });

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: { code: "entry_reconciliation_required" } });
    expect(runtime.submitCompetitionEntry).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unauthenticated", 401, "unauthenticated"],
    ["forbidden", 403, "insufficient_scope"],
    ["session_unavailable", 503, "session_unavailable"],
  ])("rejects %s before parsing or invoking the saga", async (reason, status, code) => {
    runtime.authenticateAgentSession.mockResolvedValueOnce({ ok: false, error: { code: reason } });
    const response = await POST(new NextRequest("http://localhost/api/competition/entries", {
      method: "POST",
      headers: { authorization: "Bearer invalid" },
      body: "not-json",
    }));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code } });
    expect(runtime.submitCompetitionEntry).not.toHaveBeenCalled();
  });
});
