import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const pocFixture = join(packageDirectory, "test-fixtures", "stdio-compatibility-server.mjs");

type JsonRpcMessage = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
};

class StdioFixture {
  private readonly pending = new Map<number, (message: JsonRpcMessage) => void>();
  private readonly notifications: JsonRpcMessage[] = [];
  private nextId = 1;
  private readonly lines;
  private readonly process;

  constructor() {
    this.process = execFile(process.execPath, [pocFixture], { cwd: packageDirectory });
    this.lines = createInterface({ input: this.process.stdout! });
    this.lines.on("line", (line) => {
      const message = JSON.parse(line) as JsonRpcMessage;
      if (message.id !== undefined) {
        this.pending.get(message.id)?.(message);
      } else {
        this.notifications.push(message);
      }
    });
  }

  startRequest(method: string, params?: Record<string, unknown>): { id: number; response: Promise<JsonRpcMessage> } {
    const id = this.nextId++;
    const response = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method} response`));
      }, 2_000);
      this.pending.set(id, (message) => {
        clearTimeout(timeout);
        this.pending.delete(id);
        resolve(message);
      });
    });
    this.process.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return { id, response };
  }

  async request(method: string, params?: Record<string, unknown>): Promise<JsonRpcMessage> {
    return await this.startRequest(method, params).response;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.process.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async notification(method: string): Promise<JsonRpcMessage> {
    const deadline = Date.now() + 2_000;
    while (!this.notifications.some((message) => message.method === method)) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${method}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.notifications.find((message) => message.method === method)!;
  }

  async close(): Promise<void> {
    this.process.stdin!.end();
    await once(this.process, "exit");
    this.lines.close();
  }
}

describe("stdio MCP compatibility POC", () => {
  it("proves stable negotiation, resource update cleanup, cancellation, and progress outside production MCP code", async () => {
    expect(existsSync(pocFixture), "missing #152 SDK compatibility POC fixture").toBe(true);
    const fixture = new StdioFixture();

    try {
      const initialize = await fixture.request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: { resources: { subscribe: true } },
        clientInfo: { name: "harness-arena-conformance", version: "0.0.0" },
      });
      expect(initialize.error).toBeUndefined();
      expect(initialize.result).toMatchObject({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {}, resources: { subscribe: true } },
      });

      fixture.notify("notifications/initialized");
      const tools = await fixture.request("tools/list");
      expect(tools.error).toBeUndefined();
      expect(tools.result).toMatchObject({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "get_run_events" }),
          expect.objectContaining({ name: "poc_progress" }),
          expect.objectContaining({ name: "poc_wait_for_cancel" }),
          expect.objectContaining({ name: "poc_subscription_state" }),
        ]),
      });

      const resources = await fixture.request("resources/list");
      expect(resources.error).toBeUndefined();
      const firstResource = (resources.result as { resources: Array<{ uri: string }> }).resources[0];
      expect(firstResource).toEqual(expect.objectContaining({ uri: expect.any(String) }));

      expect((await fixture.request("resources/subscribe", { uri: firstResource.uri })).error).toBeUndefined();
      expect(await fixture.notification("notifications/resources/updated")).toMatchObject({ params: { uri: firstResource.uri } });
      // Unsubscribe is the protocol-level cancellation of resources/updated notifications.
      expect((await fixture.request("resources/unsubscribe", { uri: firstResource.uri })).error).toBeUndefined();
      expect(await fixture.request("tools/call", { name: "poc_subscription_state", arguments: {} })).toMatchObject({
        result: { structuredContent: { activeSubscriptions: 0 } },
      });

      const progress = fixture.request("tools/call", { name: "poc_progress", arguments: {}, _meta: { progressToken: "poc-progress" } });
      expect(await fixture.notification("notifications/progress")).toMatchObject({ params: { progressToken: "poc-progress" } });
      expect((await progress).error).toBeUndefined();

      const cancel = fixture.startRequest("tools/call", { name: "poc_wait_for_cancel", arguments: {} });
      fixture.notify("notifications/cancelled", { requestId: cancel.id, reason: "conformance cleanup" });
      expect(await cancel.response).toMatchObject({
        result: { structuredContent: { cancelled: true } },
      });
    } finally {
      await fixture.close();
    }
  });
});
