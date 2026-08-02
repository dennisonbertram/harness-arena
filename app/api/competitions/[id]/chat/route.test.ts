import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  authenticateAgentSession: vi.fn(),
  getLiveCompetition: vi.fn(),
  readCompetitionChat: vi.fn(),
  postCompetitionMessage: vi.fn(),
}));

vi.mock("@/lib/agent-network-runtime", () => ({ getAgentNetworkRuntime: () => runtime }));

import { GET, POST } from "./route";

const actor = { id: "00000000-0000-0000-0000-000000000101", github_id: 101, github_login: "alice" };
const page = {
  messages: [{ id: "message-1", sequence: 1, body: "participant supplied body", author: { github_id: 202, github_login: "bob" }, reply_to_id: "message-0", mentions: ["alice"], unresolved_mentions: ["nobody"] }],
  next_cursor: "chat.v1.opaque", has_more: false, high_water_mark: 1,
};
const message = { id: "message-2", sequence: 2, body: "private participant body", author: { github_id: 101, github_login: "alice" }, mentions: [], unresolved_mentions: [] };
const context = (id = "live-cup") => ({ params: Promise.resolve({ id }) });
const get = (query = "") => new NextRequest(`http://localhost/api/competitions/live-cup/chat${query}`);
const post = (body: unknown, headers: HeadersInit = { "content-type": "application/json", authorization: "Bearer scoped-session" }) => new NextRequest("http://localhost/api/competitions/live-cup/chat", { method: "POST", headers, body: JSON.stringify(body) });

describe("GET/POST /api/competitions/[id]/chat", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.authenticateAgentSession.mockResolvedValue({ ok: true, actor });
    runtime.getLiveCompetition.mockResolvedValue({ id: "live-cup", status: "live" });
    runtime.readCompetitionChat.mockResolvedValue({ ok: true, page });
    runtime.postCompetitionMessage.mockResolvedValue({ ok: true, message });
  });

  it("authenticates a scoped reader and maps bounded cursor pagination exactly", async () => {
    const response = await GET(get("?after_cursor=chat.v1.opaque&limit=25&wait_seconds=7"), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ page });
    expect(runtime.authenticateAgentSession).toHaveBeenCalledWith(expect.any(NextRequest), { requiredScopes: ["competitions:read", "chat:read"] });
    expect(runtime.getLiveCompetition).toHaveBeenCalledWith("live-cup");
    expect(runtime.readCompetitionChat).toHaveBeenCalledWith({ actor, competition_id: "live-cup", cursor: "chat.v1.opaque", limit: 25, wait_seconds: 7 });
    expect(JSON.stringify(page)).not.toContain(actor.id);
  });

  it.each([
    ["?limit=0"], ["?limit=101"], ["?limit=1.5"], ["?wait_seconds=-1"], ["?wait_seconds=26"], ["?after_cursor="], ["?unknown=value"],
  ])("rejects strict, bounded query input before it reaches the facade: %s", async (query) => {
    const response = await GET(get(query), context());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "invalid_query" } });
    expect(runtime.readCompetitionChat).not.toHaveBeenCalled();
  });

  it("maps read auth, membership, competition, and service failures to stable public errors", async () => {
    runtime.authenticateAgentSession.mockResolvedValueOnce({ ok: false, error: { code: "unauthenticated" } });
    const unauthenticated = await GET(get(), context());
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toEqual({ error: { code: "unauthenticated" } });

    runtime.readCompetitionChat.mockResolvedValueOnce({ ok: false, error: { code: "forbidden" } });
    const forbidden = await GET(get(), context());
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({ error: { code: "not_a_participant" } });

    runtime.getLiveCompetition.mockResolvedValueOnce(null);
    const missing = await GET(get(), context());
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: { code: "competition_not_found" } });

    runtime.readCompetitionChat.mockRejectedValueOnce(new Error("connection failed postgres://private"));
    const unavailable = await GET(get(), context());
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: { code: "chat_unavailable" } });
  });

  it("accepts only the exact bounded post body and maps reply/idempotency fields", async () => {
    const response = await POST(post({ body: "hello @bob", reply_to_id: "message-1", idempotency_key: "post-1" }), context());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ message });
    expect(runtime.authenticateAgentSession).toHaveBeenCalledWith(expect.any(NextRequest), { requiredScopes: ["competitions:read", "chat:write"] });
    expect(runtime.postCompetitionMessage).toHaveBeenCalledWith({ actor, competition_id: "live-cup", body: "hello @bob", reply_to_id: "message-1", idempotency_key: "post-1" });
  });

  it.each([
    [{ body: "", idempotency_key: "post-1" }],
    [{ body: "x".repeat(4_001), idempotency_key: "post-1" }],
    [{ body: "ok", idempotency_key: "" }],
    [{ body: "ok", idempotency_key: "post-1", extra: true }],
  ])("rejects malformed post JSON before it reaches the facade", async (body) => {
    const response = await POST(post(body), context());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "invalid_body" } });
    expect(runtime.postCompetitionMessage).not.toHaveBeenCalled();
  });

  it("caps request bodies near 1 MiB and does not log participant-supplied content on a failure", async () => {
    const participantBody = `NEVER-LOG-${"x".repeat(1_048_576)}`;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const oversized = new NextRequest("http://localhost/api/competitions/live-cup/chat", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer scoped-session", "content-length": String(participantBody.length + 64) },
      body: JSON.stringify({ body: participantBody, idempotency_key: "large" }),
    });
    const response = await POST(oversized, context());
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: { code: "body_too_large" } });
    expect(runtime.postCompetitionMessage).not.toHaveBeenCalled();
    expect(spy.mock.calls.flat().join(" ")).not.toContain("NEVER-LOG-");
    spy.mockRestore();
  });

  it("maps conflict, rate limit, and unavailable post outcomes without logging the participant body", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runtime.postCompetitionMessage.mockResolvedValueOnce({ ok: false, error: { code: "conflict" } });
    const conflict = await POST(post({ body: "PRIVATE-PARTICIPANT-BODY", idempotency_key: "post-1" }), context());
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: { code: "idempotency_conflict" } });

    runtime.postCompetitionMessage.mockResolvedValueOnce({ ok: false, error: { code: "rate_limited" } });
    const limited = await POST(post({ body: "PRIVATE-PARTICIPANT-BODY", idempotency_key: "post-2" }), context());
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({ error: { code: "rate_limited" } });

    runtime.postCompetitionMessage.mockRejectedValueOnce(new Error("database error includes PRIVATE-PARTICIPANT-BODY"));
    const unavailable = await POST(post({ body: "PRIVATE-PARTICIPANT-BODY", idempotency_key: "post-3" }), context());
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: { code: "chat_unavailable" } });
    expect(spy.mock.calls.flat().join(" ")).not.toContain("PRIVATE-PARTICIPANT-BODY");
    spy.mockRestore();
  });
});
