import { describe, expect, it, vi } from "vitest";
import { HarnessArenaClient } from "./client.js";
import { toolDefinitions } from "./server.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const credentials = () => ({ get: vi.fn().mockResolvedValue({ token: "arena-session", github_login: "octo", expires_at: "2030-01-01T00:00:00Z" }), set: vi.fn() });

describe("agent session lifecycle MCP tools", () => {
  it("uses authenticated exact HTTP mappings for list, current logout, and targeted revocation", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(200, { sessions: [] }))
      .mockResolvedValueOnce(json(200, { revoked: true }))
      .mockResolvedValueOnce(json(200, { revoked: true }));
    const client = new HarnessArenaClient({ baseUrl: "https://arena.example.test", credentials: credentials(), fetch: fetcher });

    await client.listSessions();
    await client.logout();
    await client.revokeSession({ session_id: "session-other" });

    expect(fetcher.mock.calls.map(([url]) => url.toString())).toEqual([
      "https://arena.example.test/api/agent/sessions",
      "https://arena.example.test/api/agent/sessions/current/revoke",
      "https://arena.example.test/api/agent/sessions/session-other/revoke",
    ]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer arena-session" } });
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer arena-session" }, body: JSON.stringify({}) });
    expect(fetcher.mock.calls[2][1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer arena-session" }, body: JSON.stringify({}) });
  });

  it("exposes strict bounded lifecycle schemas and exact handlers", async () => {
    const client = { listSessions: vi.fn().mockResolvedValue({ sessions: [] }), logout: vi.fn().mockResolvedValue({ revoked: true }), revokeSession: vi.fn().mockResolvedValue({ revoked: true }) };
    const definitions = toolDefinitions(client as never);
    const list = definitions.list_sessions;
    const logout = definitions.logout;
    const revoke = definitions.revoke_session;

    expect(list.inputSchema.safeParse({}).success).toBe(true);
    expect(list.inputSchema.safeParse({ extra: true }).success).toBe(false);
    expect(logout.inputSchema.safeParse({}).success).toBe(true);
    expect(logout.inputSchema.safeParse({ extra: true }).success).toBe(false);
    expect(revoke.inputSchema.safeParse({ session_id: "session-1" }).success).toBe(true);
    expect(revoke.inputSchema.safeParse({ session_id: "" }).success).toBe(false);
    expect(revoke.inputSchema.safeParse({ session_id: "x".repeat(257) }).success).toBe(false);
    expect(revoke.inputSchema.safeParse({ session_id: "session-1", extra: true }).success).toBe(false);

    await list.handler({});
    await logout.handler({});
    await revoke.handler({ session_id: "session-1" });
    expect(client.listSessions).toHaveBeenCalledWith();
    expect(client.logout).toHaveBeenCalledWith();
    expect(client.revokeSession).toHaveBeenCalledWith({ session_id: "session-1" });
  });
});
