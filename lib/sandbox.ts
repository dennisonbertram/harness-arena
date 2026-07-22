import { Sandbox } from "@vercel/sandbox";
import { log } from "./log";
import { getStorage } from "./storage";
import { buildRunnerTasks } from "./tasks-for-runner";
import type { Run } from "./types";

// FINAL golden snapshot per architect spike (issue #7 comments): docker +
// the 10 task images + node:22-slim + /opt/agentkit.tgz (pi 0.81.1) baked
// in. Override via RUNNER_SNAPSHOT_ID for a future rebuild without a
// redeploy.
const DEFAULT_SNAPSHOT_ID = "snap_Abzf52PEGHdTSZpsPIAZpKmj08Ds";
const SANDBOX_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_CALLBACK_BASE = "https://harness-arena-psi.vercel.app";

interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

// On a deployed Vercel function, VERCEL_OIDC_TOKEN is injected automatically
// and the SDK auto-authenticates -- nothing to do. Locally (outside a
// deployed function) there's no OIDC token, so spread these through
// explicitly when present.
function vercelCredentials(): VercelCredentials | Record<string, never> {
  const { VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID } = process.env;
  if (VERCEL_TOKEN && VERCEL_TEAM_ID && VERCEL_PROJECT_ID) {
    return { token: VERCEL_TOKEN, teamId: VERCEL_TEAM_ID, projectId: VERCEL_PROJECT_ID };
  }
  return {};
}

// Single-quote shell escaping: safe for embedding arbitrary values (secrets,
// base64 blobs) as literal args inside a `sh -c` string.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`sandbox: missing required env var ${name}`);
  return value;
}

// Any failure here (missing env, SDK throw, non-zero bootstrap/launch exit)
// must surface as run.failed instead of leaving the run stuck at `queued`
// forever -- that's the whole point of this ticket.
async function markFailed(run: Run, err: unknown): Promise<void> {
  const storage = getStorage();
  const message = err instanceof Error ? err.message : String(err);
  log("error", "sandbox.create_failed", { run_id: run.id, error: message });
  const failed: Run = { ...run, status: "failed", finished_at: new Date().toISOString() };
  await storage.putRun(failed);
  await storage.appendRunEvents(run.id, [
    { ts: new Date().toISOString(), type: "run.failed", payload: { error: message, stage: "sandbox_create" } },
  ]);
}

export async function createRunSandbox(run: Run, opts: { prompt: string }): Promise<{ sandbox_id: string }> {
  try {
    const callbackBase = process.env.CALLBACK_BASE ?? DEFAULT_CALLBACK_BASE;
    const runnerCallbackSecret = requireEnv("RUNNER_CALLBACK_SECRET");
    const aiGatewayApiKey = requireEnv("AI_GATEWAY_API_KEY");
    const budgetCapUsd = process.env.RUN_BUDGET_CAP_USD ?? "2";
    const systemPromptB64 = Buffer.from(opts.prompt, "utf8").toString("base64");
    const tasksJsonB64 = Buffer.from(JSON.stringify(buildRunnerTasks()), "utf8").toString("base64");

    const sandbox = await Sandbox.create({
      source: { type: "snapshot", snapshotId: process.env.RUNNER_SNAPSHOT_ID ?? DEFAULT_SNAPSHOT_ID },
      timeout: SANDBOX_TIMEOUT_MS,
      ...vercelCredentials(),
    });

    const storage = getStorage();
    const withSandboxId: Run = { ...run, sandbox_id: sandbox.name };
    await storage.putRun(withSandboxId);
    await storage.appendRunEvents(run.id, [
      { ts: new Date().toISOString(), type: "run.sandbox_creating", payload: { sandbox_id: sandbox.name } },
    ]);
    log("info", "sandbox.creating", { run_id: run.id, sandbox_id: sandbox.name });

    const bootstrapCmd =
      `mkdir -p /opt/runner && ` +
      `curl -fsSL ${shQuote(`${callbackBase}/runner-bundle.tgz`)} -o /tmp/rb.tgz && ` +
      `tar -xzf /tmp/rb.tgz -C /opt/runner`;
    const bootstrapResult = await sandbox.runCommand("sh", ["-c", bootstrapCmd]);
    if (bootstrapResult.exitCode !== 0) {
      throw new Error(`runner bundle bootstrap failed (exit ${bootstrapResult.exitCode})`);
    }

    const runnerEnv: Record<string, string> = {
      RUN_ID: run.id,
      CALLBACK_BASE: callbackBase,
      RUNNER_CALLBACK_SECRET: runnerCallbackSecret,
      AI_GATEWAY_API_KEY: aiGatewayApiKey,
      SYSTEM_PROMPT_B64: systemPromptB64,
      BUDGET_CAP_USD: budgetCapUsd,
      TASKS_JSON_B64: tasksJsonB64,
    };
    const envAssignments = Object.entries(runnerEnv)
      .map(([key, value]) => `${key}=${shQuote(value)}`)
      .join(" ");
    const launchCmd = `nohup env ${envAssignments} node /opt/runner/scripts/runner/runner.mjs >/var/log/runner.log 2>&1 &`;
    const launchResult = await sandbox.runCommand("sh", ["-c", launchCmd]);
    if (launchResult.exitCode !== 0) {
      throw new Error(`runner launch failed (exit ${launchResult.exitCode})`);
    }

    return { sandbox_id: sandbox.name };
  } catch (err) {
    await markFailed(run, err);
    throw err;
  }
}
