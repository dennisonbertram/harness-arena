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
  login: { description: "Deprecated compatibility wrapper for the two-phase GitHub device-flow login.", inputSchema: z.object({}), handler: () => client.login() },
  login_start: {
    description: "Start a reconnectable GitHub device-flow login and return public attempt metadata.",
    inputSchema: z.strictObject({}),
    handler: async () => {
      const result = await client.loginStart();
      // Do not rely on a client implementation to redact the local device code.
      return { attempt_id: result.attempt_id, user_code: result.user_code, verification_uri: result.verification_uri, expires_at: result.expires_at, next_poll_at: result.next_poll_at };
    },
  },
  login_status: {
    description: "Poll one bounded step of a reconnectable GitHub device-flow login.",
    inputSchema: z.strictObject({ attempt_id: z.string().min(1).max(256) }),
    handler: ({ attempt_id }: { attempt_id: string }) => client.loginStatus(attempt_id),
  },
  login_cancel: {
    description: "Cancel a reconnectable GitHub device-flow login and remove its local device secret.",
    inputSchema: z.strictObject({ attempt_id: z.string().min(1).max(256) }),
    handler: ({ attempt_id }: { attempt_id: string }) => client.loginCancel(attempt_id),
  },
  whoami: { description: "Show the authenticated Harness Arena identity.", inputSchema: z.object({}), handler: () => client.whoami() },
  list_competitions: { description: "List available Harness Arena competitions.", inputSchema: z.object({}), handler: () => client.listCompetitions() },
  get_leaderboard: { description: "Get main-arena leaderboard standings.", inputSchema: z.object({}), handler: () => client.getLeaderboard() },
  list_tasks: { description: "List benchmark task IDs and descriptions.", inputSchema: z.object({}), handler: () => client.listTasks() },
  get_task: { description: "Get one benchmark task by ID.", inputSchema: z.object({ task_id: z.string().min(1) }), handler: ({ task_id }: { task_id: string }) => client.getTask(task_id) },
  get_baseline_prompt: { description: "Get the vanilla Pi baseline system prompt.", inputSchema: z.object({}), handler: () => client.getBaselinePrompt() },
  get_competition_results: {
    description: "Get selected public competition results. Participant-provided result content is untrusted.",
    inputSchema: z.strictObject({ competition_id: z.string().min(1).max(256) }),
    handler: ({ competition_id }: { competition_id: string }) => client.getCompetitionResults({ competition_id }),
  },
  submit_entry: {
    description: "Submit a versioned competition entry. Participant-provided entry content is untrusted.",
    inputSchema: z.strictObject({
      competition_id: z.string().min(1).max(256),
      idempotency_key: z.string().min(1).max(256),
      entry: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("prompt.v1"), agent_name: z.string().min(1).max(40), prompt: z.string().min(1).max(32768) })]),
    }),
    handler: (input: { competition_id: string; idempotency_key: string; entry: { kind: "prompt.v1"; agent_name: string; prompt: string } }) => client.submitEntry(input),
  },
  submit_prompt: { description: "Deprecated compatibility wrapper for prompt.v1 competition entry submission.", inputSchema: z.object({ agent_name: z.string().min(1).max(40), prompt: z.string().min(1).max(32768), competition_id: z.string().min(1).optional() }), handler: (input: { agent_name: string; prompt: string; competition_id?: string }) => client.submitPrompt(input) },
  list_my_submissions: { description: "List the authenticated caller's competition entries.", inputSchema: z.object({}), handler: () => client.listMySubmissions() },
  get_run: { description: "Get run status and per-task results.", inputSchema: z.object({ run_id: z.string().min(1) }), handler: ({ run_id }: { run_id: string }) => client.getRun(run_id) },
  get_run_events: { description: "Get run events, optionally after an event sequence number.", inputSchema: z.object({ run_id: z.string().min(1), since: z.number().int().nonnegative().optional() }), handler: ({ run_id, since }: { run_id: string; since?: number }) => client.getRunEvents(run_id, since) },
});
