import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { HarnessArenaClient } from "./client.js";
import { toolDefinitions } from "./server.js";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const credentials = () => ({ get: vi.fn().mockResolvedValue({ token: "arena-session", github_login: "octo", expires_at: "2030-01-01T00:00:00Z" }), set: vi.fn() });

type Message = { id?: number; method?: string; result?: unknown; error?: unknown };
class BuiltStdioClient {
  private nextId = 1;
  private readonly pending = new Map<number, (message: Message) => void>();
  private readonly process;
  private readonly lines;

  constructor(env: NodeJS.ProcessEnv = {}) {
    this.process = execFile(process.execPath, [join(packageDirectory, "dist/index.js")], { cwd: packageDirectory, env: { ...process.env, ...env } });
    this.lines = createInterface({ input: this.process.stdout! });
    this.lines.on("line", (line) => {
      const message = JSON.parse(line) as Message;
      if (message.id !== undefined) this.pending.get(message.id)?.(message);
    });
  }

  async request(method: string, params?: Record<string, unknown>): Promise<Message> {
    return await this.startRequest(method, params).response;
  }

  startRequest(method: string, params?: Record<string, unknown>): { id: number; response: Promise<Message> } {
    const id = this.nextId++;
    const response = new Promise<Message>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 2_000);
      this.pending.set(id, (message) => { clearTimeout(timeout); this.pending.delete(id); resolve(message); });
    });
    this.process.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return { id, response };
  }

  notify(method: string, params?: Record<string, unknown>): void { this.process.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); }
  async close(): Promise<void> { this.process.stdin!.end(); await once(this.process, "exit"); this.lines.close(); }
}

describe("competition chat MCP tools", () => {
  it("uses authenticated exact HTTP mappings and retains structured API errors", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(200, { membership: "active" }))
      .mockResolvedValueOnce(json(200, { messages: [], page: { next_cursor: "opaque-next" } }))
      .mockResolvedValueOnce(json(200, { message: { id: "message-1" } }));
    const client = new HarnessArenaClient({ baseUrl: "https://arena.example.test", credentials: credentials(), fetch: fetcher });

    await client.joinCompetitionChat({ competition_id: "summer 2029" });
    await client.readCompetitionChat({ competition_id: "summer 2029", after_cursor: "opaque+/=", limit: 50, wait_seconds: 25 });
    await client.postCompetitionMessage({ competition_id: "summer 2029", body: "Hello", reply_to_id: "message-0", idempotency_key: "post-1" });

    expect(fetcher.mock.calls.map(([url]) => url.toString())).toEqual([
      "https://arena.example.test/api/competitions/summer%202029/chat/join",
      "https://arena.example.test/api/competitions/summer%202029/chat?after_cursor=opaque%2B%2F%3D&limit=50&wait_seconds=25",
      "https://arena.example.test/api/competitions/summer%202029/chat",
    ]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer arena-session" } });
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer arena-session" } });
    expect(fetcher.mock.calls[2][1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer arena-session" }, body: JSON.stringify({ body: "Hello", reply_to_id: "message-0", idempotency_key: "post-1" }) });

    const denied = new HarnessArenaClient({ baseUrl: "https://arena.example.test", credentials: credentials(), fetch: vi.fn().mockResolvedValue(json(403, { error: "not a competition participant" })) });
    await expect(denied.readCompetitionChat({ competition_id: "summer-2029" })).rejects.toThrow("Harness Arena request failed: not a competition participant");
  });

  it("propagates MCP cancellation to an in-flight HTTP-backed chat tool", async () => {
    const home = await mkdtemp(join(tmpdir(), "harness-arena-mcp-cancel-"));
    const credentialDirectory = join(home, ".harness-arena");
    await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(credentialDirectory, "credentials.json"), JSON.stringify({
      version: 1,
      credentials: { "http://127.0.0.1": { token: "local-test-token", github_login: "octo", expires_at: "2030-01-01T00:00:00Z" } },
    }), { mode: 0o600 });

    let releaseResponse: (() => void) | undefined;
    let sawRequest!: () => void;
    const requestStarted = new Promise<void>((resolve) => { sawRequest = resolve; });
    let sawAbort!: () => void;
    const requestAborted = new Promise<void>((resolve) => { sawAbort = resolve; });
    const stub = createServer((request, response) => {
      if (request.url?.startsWith("/api/competitions/live-cup/chat")) {
        sawRequest();
        request.once("aborted", sawAbort);
        releaseResponse = () => response.end(JSON.stringify({ page: { messages: [], next_cursor: null } }));
      } else response.statusCode = 404;
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const address = stub.address();
    if (!address || typeof address === "string") throw new Error("local HTTP stub did not bind a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await writeFile(join(credentialDirectory, "credentials.json"), JSON.stringify({
      version: 1,
      credentials: { [baseUrl]: { token: "local-test-token", github_login: "octo", expires_at: "2030-01-01T00:00:00Z" } },
    }), { mode: 0o600 });
    const client = new BuiltStdioClient({ HOME: home, HARNESS_ARENA_URL: baseUrl });

    try {
      await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cancellation-regression", version: "0.0.0" } });
      client.notify("notifications/initialized");
      const call = client.startRequest("tools/call", { name: "read_competition_chat", arguments: { competition_id: "live-cup", wait_seconds: 25 } });
      await requestStarted;
      client.notify("notifications/cancelled", { requestId: call.id, reason: "test cancellation" });
      await Promise.race([
        requestAborted,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("HTTP request was not aborted after MCP cancellation")), 500)),
      ]);
    } finally {
      releaseResponse?.();
      await client.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });

  it("exposes strict bounded chat schemas, delegates handlers, and marks participant content untrusted", async () => {
    const client = {
      joinCompetitionChat: vi.fn().mockResolvedValue({ membership: "active" }),
      readCompetitionChat: vi.fn().mockResolvedValue({ messages: [] }),
      postCompetitionMessage: vi.fn().mockResolvedValue({ message: { id: "message-1" } }),
    };
    const definitions = toolDefinitions(client as never);
    const join = definitions.join_competition_chat;
    const read = definitions.read_competition_chat;
    const post = definitions.post_competition_message;
    const message = { competition_id: "summer-2029", body: "Hello", reply_to_id: "message-0", idempotency_key: "post-1" };

    expect(join.inputSchema.safeParse({ competition_id: "summer-2029" }).success).toBe(true);
    expect(join.inputSchema.safeParse({ competition_id: "summer-2029", extra: true }).success).toBe(false);
    expect(read.inputSchema.safeParse({ competition_id: "summer-2029", after_cursor: "opaque", limit: 1, wait_seconds: 0 }).success).toBe(true);
    expect(read.inputSchema.safeParse({ competition_id: "summer-2029", limit: 101 }).success).toBe(false);
    expect(read.inputSchema.safeParse({ competition_id: "summer-2029", wait_seconds: 26 }).success).toBe(false);
    expect(read.inputSchema.safeParse({ competition_id: "x".repeat(257), after_cursor: "x".repeat(513) }).success).toBe(false);
    expect(post.inputSchema.safeParse(message).success).toBe(true);
    expect(post.inputSchema.safeParse({ ...message, body: "" }).success).toBe(false);
    expect(post.inputSchema.safeParse({ ...message, body: "x".repeat(4_001) }).success).toBe(false);
    expect(post.inputSchema.safeParse({ ...message, idempotency_key: "" }).success).toBe(false);
    expect(post.inputSchema.safeParse({ ...message, extra: true }).success).toBe(false);
    expect(read.description).toMatch(/untrusted/i);
    expect(post.description).toMatch(/untrusted/i);

    await join.handler({ competition_id: "summer-2029" });
    await read.handler({ competition_id: "summer-2029", after_cursor: "opaque", limit: 1, wait_seconds: 0 });
    await post.handler(message);
    expect(client.joinCompetitionChat).toHaveBeenCalledWith({ competition_id: "summer-2029" });
    expect(client.readCompetitionChat).toHaveBeenCalledWith({ competition_id: "summer-2029", after_cursor: "opaque", limit: 1, wait_seconds: 0 });
    expect(client.postCompetitionMessage).toHaveBeenCalledWith(message);
  });

  it("ships chat polling tools and a subscribable stable chat resource template over stdio", async () => {
    const client = new BuiltStdioClient();
    try {
      const initialize = await client.request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: { resources: { subscribe: true } },
        clientInfo: { name: "chat-conformance", version: "0.0.0" },
      });
      expect(initialize.error).toBeUndefined();
      expect(initialize.result).toMatchObject({ capabilities: { resources: { subscribe: true } } });
      client.notify("notifications/initialized");
      const tools = await client.request("tools/list");
      expect(tools.result).toMatchObject({ tools: expect.arrayContaining([
        expect.objectContaining({ name: "join_competition_chat" }),
        expect.objectContaining({ name: "read_competition_chat" }),
        expect.objectContaining({ name: "post_competition_message" }),
      ]) });
      const templates = await client.request("resources/templates/list");
      expect(templates.result).toMatchObject({ resourceTemplates: expect.arrayContaining([
        expect.objectContaining({ uriTemplate: "harness-arena://competitions/{competition_id}/chat" }),
      ]) });
    } finally {
      await client.close();
    }
  });
});
