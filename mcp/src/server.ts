import { z } from "zod";
import { HarnessArenaClient, ToolError } from "./client.js";

export interface ToolResult {
  // The SDK's CallToolResult carries an index signature; without it this type
  // is not assignable to a registerTool handler's return type.
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export const toToolResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: { result: value },
});

export const toToolError = (error: unknown): ToolResult => {
  const message = error instanceof ToolError ? error.message : "Harness Arena MCP encountered an unexpected error.";
  return { content: [{ type: "text", text: JSON.stringify({ error: { message } }) }], structuredContent: { error: { message } }, isError: true };
};

export const toolDefinitions = (client: HarnessArenaClient) => ({
  login: { description: "Authenticate with Harness Arena using the GitHub device flow.", inputSchema: z.object({}), handler: () => client.login() },
  whoami: { description: "Show the authenticated Harness Arena identity.", inputSchema: z.object({}), handler: () => client.whoami() },
  list_competitions: { description: "List available Harness Arena competitions.", inputSchema: z.object({}), handler: () => client.listCompetitions() },
  get_leaderboard: { description: "Get main-arena leaderboard standings.", inputSchema: z.object({}), handler: () => client.getLeaderboard() },
  list_tasks: { description: "List benchmark task IDs and descriptions.", inputSchema: z.object({}), handler: () => client.listTasks() },
  get_task: { description: "Get one benchmark task by ID.", inputSchema: z.object({ task_id: z.string().min(1) }), handler: ({ task_id }: { task_id: string }) => client.getTask(task_id) },
  get_baseline_prompt: { description: "Get the vanilla Pi baseline system prompt.", inputSchema: z.object({}), handler: () => client.getBaselinePrompt() },
  submit_prompt: { description: "Submit a prompt to a Harness Arena competition.", inputSchema: z.object({ agent_name: z.string().min(1).max(40), prompt: z.string().min(1).max(32768), competition_id: z.string().min(1).optional() }), handler: (input: { agent_name: string; prompt: string; competition_id?: string }) => client.submitPrompt(input) },
  list_my_submissions: { description: "List the authenticated caller's competition entries.", inputSchema: z.object({}), handler: () => client.listMySubmissions() },
  get_run: { description: "Get run status and per-task results.", inputSchema: z.object({ run_id: z.string().min(1) }), handler: ({ run_id }: { run_id: string }) => client.getRun(run_id) },
  get_run_events: { description: "Get run events, optionally after an event sequence number.", inputSchema: z.object({ run_id: z.string().min(1), since: z.number().int().nonnegative().optional() }), handler: ({ run_id, since }: { run_id: string; since?: number }) => client.getRunEvents(run_id, since) },
});
