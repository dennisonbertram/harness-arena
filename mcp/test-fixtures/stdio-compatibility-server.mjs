#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const resourceUri = "harness-arena-poc://runs/example/events";
const subscriptions = new Set();
let cancelledRequests = 0;
const server = new McpServer({ name: "harness-arena-stdio-compatibility-poc", version: "0.1.0" });

// Resource subscription is deliberately exercised here, rather than advertised
// by the production MCP server before the chat design is ready.
server.server.registerCapabilities({ resources: { subscribe: true } });
server.registerResource("poc_run_events", resourceUri, { mimeType: "application/json" }, async () => ({
  contents: [{ uri: resourceUri, text: JSON.stringify({ events: [], next_cursor: 0 }) }],
}));

server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  subscriptions.add(request.params.uri);
  if (subscriptions.has(resourceUri)) await server.server.sendResourceUpdated({ uri: resourceUri });
  return {};
});

server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
  subscriptions.delete(request.params.uri);
  return {};
});

const textResult = (structuredContent) => ({
  content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  structuredContent,
});

// This advertises the durable cursor-based path independently of resource hints.
server.registerTool("get_run_events", { description: "POC cursor fallback for run events." }, async () =>
  textResult({ events: [], next_cursor: 0 }),
);

server.registerTool("poc_subscription_state", { description: "Report active POC resource subscriptions." }, async () =>
  textResult({ activeSubscriptions: subscriptions.size, cancelledRequests }),
);

server.registerTool("poc_progress", { description: "Emit one progress notification when requested." }, async (extra) => {
  if (extra._meta?.progressToken !== undefined) {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: extra._meta.progressToken, progress: 1, total: 1, message: "complete" },
    });
  }
  return textResult({ complete: true });
});

server.registerTool("poc_wait_for_cancel", { description: "Wait for the request cancellation signal." }, async (extra) => {
  if (extra._meta?.progressToken !== undefined) {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: extra._meta.progressToken, progress: 0, total: 1, message: "waiting for cancellation" },
    });
  }
  if (extra.signal.aborted) {
    cancelledRequests += 1;
  } else {
    await new Promise((resolve) => extra.signal.addEventListener("abort", () => {
      cancelledRequests += 1;
      resolve();
    }, { once: true }));
  }
  return textResult({ cancelled: extra.signal.aborted });
});

await server.connect(new StdioServerTransport());
