#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HarnessArenaClient } from "./client.js";
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

for (const [name, definition] of Object.entries(toolDefinitions(client))) {
  server.registerTool(name, { description: definition.description, inputSchema: definition.inputSchema }, async (input: unknown) => {
    try { return toToolResult(await definition.handler(input as never)); }
    catch (error) { return toToolError(error); }
  });
}

await server.connect(new StdioServerTransport());
