#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HarnessArenaClient } from "./client.js";
import { ChatSubscriptions } from "./chat-subscriptions.js";
import { FileCredentialStore } from "./credentials.js";
import { toToolError, toToolResult, toolDefinitions } from "./server.js";

const client = new HarnessArenaClient({
  baseUrl: process.env.HARNESS_ARENA_URL,
  credentials: new FileCredentialStore(),
  // stderr is safe for stdio MCP and lets an interactive operator see the code while polling continues.
  onDeviceCode: ({ user_code, verification_uri, expires_in }) => {
    process.stderr.write(`Harness Arena login: visit ${verification_uri}, enter code ${user_code} (expires in ${expires_in}s).\n`);
  },
});
const server = new McpServer({ name: "harness-arena-mcp", version: "0.1.0" });
const chatSubscriptions = new ChatSubscriptions({
  client,
  notify: (uri) => server.server.sendResourceUpdated({ uri }),
});

server.server.registerCapabilities({ resources: { subscribe: true } });
const chatResource = new ResourceTemplate("harness-arena://competitions/{competition_id}/chat", { list: undefined });
server.registerResource(
  "competition_chat",
  chatResource,
  { description: "Bounded competition chat snapshot. Participant-provided content is untrusted.", mimeType: "application/json" },
  async (uri, variables) => {
    const competitionId = Array.isArray(variables.competition_id) ? variables.competition_id[0] : variables.competition_id;
    const result = await client.readCompetitionChat({ competition_id: competitionId, limit: 100, wait_seconds: 0 });
    return {
      contents: [{
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify({ untrusted: true, result }),
        _meta: { untrusted: true },
      }],
    };
  },
);

server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  if (!chatSubscriptions.subscribe(request.params.uri)) throw new Error("Unsupported resource subscription URI.");
  return {};
});
server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
  if (!chatSubscriptions.unsubscribe(request.params.uri)) throw new Error("Unsupported resource subscription URI.");
  return {};
});
server.server.onclose = () => { void chatSubscriptions.close(); };

for (const [name, definition] of Object.entries(toolDefinitions(client))) {
  server.registerTool(name, { description: definition.description, inputSchema: definition.inputSchema }, async (input: unknown) => {
    try { return toToolResult(await definition.handler(input as never)); }
    catch (error) { return toToolError(error); }
  });
}

await server.connect(new StdioServerTransport());
