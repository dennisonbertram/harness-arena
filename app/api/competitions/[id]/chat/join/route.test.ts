import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  authenticateAgentSession: vi.fn(),
  getLiveCompetition: vi.fn(),
  joinCompetitionChat: vi.fn(),
}));

vi.mock("@/lib/agent-network-runtime", () => ({ getAgentNetworkRuntime: () => runtime }));

import { POST } from "./route";

const actor = { id: "00000000-0000-0000-0000-000000000101", github_id: 101, github_login: "alice" };
const membership = { competition_id: "live-cup", state: "active", joined_at: "2026-08-02T12:00:00.000Z" };
const request = () => new NextRequest("http://localhost/api/competitions/live-cup/chat/join", {
  method: "POST", headers: { authorization: "Bearer scoped-session" },
});
const context = (id = "live-cup") => ({ params: Promise.resolve({ id }) });

describe("POST /api/competitions/[id]/chat/join", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.authenticateAgentSession.mockResolvedValue({ ok: true, actor });
    runtime.getLiveCompetition.mockResolvedValue({ id: "live-cup", status: "live" });
    runtime.joinCompetitionChat.mockResolvedValue({ ok: true, membership });
  });

  it("requires a scoped session, validates that the competition is live, and creates an active membership", async () => {
    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ membership });
    expect(runtime.authenticateAgentSession).toHaveBeenCalledWith(expect.any(NextRequest), { requiredScopes: ["competitions:read", "chat:write"] });
    expect(runtime.getLiveCompetition).toHaveBeenCalledWith("live-cup");
    expect(runtime.joinCompetitionChat).toHaveBeenCalledWith({ actor, competition_id: "live-cup" });
  });

  it("is idempotent for an already-active participant and never returns internal entrant fields", async () => {
    const first = await POST(request(), context());
    const second = await POST(request(), context());

    await expect(first.json()).resolves.toEqual({ membership });
    await expect(second.json()).resolves.toEqual({ membership });
    expect(runtime.joinCompetitionChat).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(membership)).not.toContain(actor.id);
  });

  it.each([
    ["unauthenticated", 401, "unauthenticated"],
    ["forbidden", 403, "insufficient_scope"],
  ])("returns the stable %s error without consulting competition state", async (reason, status, code) => {
    runtime.authenticateAgentSession.mockResolvedValueOnce({ ok: false, error: { code: reason } });
    const response = await POST(request(), context());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code } });
    expect(runtime.getLiveCompetition).not.toHaveBeenCalled();
  });

  it("returns stable 404, 409, and 503 errors", async () => {
    runtime.getLiveCompetition.mockResolvedValueOnce(null);
    await expect((await POST(request(), context())).json()).resolves.toEqual({ error: { code: "competition_not_found" } });

    runtime.joinCompetitionChat.mockResolvedValueOnce({ ok: false, error: { code: "conflict" } });
    const conflict = await POST(request(), context());
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: { code: "membership_conflict" } });

    runtime.joinCompetitionChat.mockRejectedValueOnce(new Error("postgres://private-host"));
    const unavailable = await POST(request(), context());
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: { code: "chat_unavailable" } });
  });
});
