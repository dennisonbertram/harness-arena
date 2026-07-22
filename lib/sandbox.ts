import { Sandbox } from "@vercel/sandbox";
import type { NetworkPolicy } from "@vercel/sandbox";
import { log } from "./log";
import { getStorage } from "./storage";
import { buildRunnerTasks } from "./tasks-for-runner";
import type { Run } from "./types";

// FINAL golden snapshot per architect spike (issue #7 comments): docker +
// the 10 task images + node:22-slim + /opt/agentkit.tgz (pi 0.81.1) baked
// in. Override via RUNNER_SNAPSHOT_ID for a future rebuild without a
// redeploy.
const DEFAULT_SNAPSHOT_ID = "snap_Abzf52PEGHdTSZpsPIAZpKmj08Ds";
const DEFAULT_CALLBACK_BASE = "https://harness-arena-psi.vercel.app";

// Raised from 45 to 120 minutes (issue #23 finding E) -- the Vercel account
// is confirmed Pro (5h sandboxes supported), and the per-task timeout caps
// in lib/tasks-for-runner.ts bound worst-case run duration to well under
// 120 minutes regardless. Override via RUNNER_SANDBOX_TIMEOUT_MIN.
const DEFAULT_SANDBOX_TIMEOUT_MIN = 120;

function sandboxTimeoutMs(): number {
  const minutes = Number(process.env.RUNNER_SANDBOX_TIMEOUT_MIN ?? DEFAULT_SANDBOX_TIMEOUT_MIN);
  return minutes * 60 * 1000;
}

// Egress allowlist for the sandbox's default network policy (issue #23
// finding D). Full gateway-only lockdown (proxying every outbound call,
// including AI Gateway, through our own forwardURL) is CONCEPT.md's
// documented v1.1 item, not built here. Compensating controls in the
// meantime: trace redaction of secrets before upload (issue #19 finding 1),
// planned post-POC key rotation, and the judge rejecting prompts that
// attempt exfiltration. Set RUNNER_NETWORK_MODE=allow-all to disable this
// allowlist entirely for local debugging.
const NETWORK_ALLOWLIST = [
  "ai-gateway.vercel.sh",
  "harness-arena-psi.vercel.app",
  "*.public.blob.vercel-storage.com",
  "astral.sh",
  "pypi.org",
  "files.pythonhosted.org",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "deb.debian.org",
  "security.debian.org",
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "ports.ubuntu.com",
  "registry.npmjs.org",
  // Docker images are baked into the snapshot -- no docker registry needed.
];

function networkPolicy(): NetworkPolicy {
  if (process.env.RUNNER_NETWORK_MODE === "allow-all") return "allow-all";
  return { allow: NETWORK_ALLOWLIST };
}

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

// Single-quote shell escaping: safe for embedding arbitrary values as
// literal args inside a `sh -c` string. Only used for the bootstrap
// command below, which carries no secrets.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`sandbox: missing required env var ${name}`);
  return value;
}

// Any failure here (missing env, SDK throw, non-zero bootstrap exit) must
// surface as run.failed instead of leaving the run stuck at `queued`
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
      timeout: sandboxTimeoutMs(),
      networkPolicy: networkPolicy(),
      ...vercelCredentials(),
    });

    const storage = getStorage();
    const withSandboxId: Run = { ...run, sandbox_id: sandbox.name };
    await storage.putRun(withSandboxId);
    await storage.appendRunEvents(run.id, [
      { ts: new Date().toISOString(), type: "run.sandbox_creating", payload: { sandbox_id: sandbox.name } },
    ]);
    log("info", "sandbox.creating", { run_id: run.id, sandbox_id: sandbox.name });

    // Bootstrap carries no secrets, so a plain shell string is fine here.
    const bootstrapCmd =
      `mkdir -p /opt/runner && ` +
      `curl -fsSL ${shQuote(`${callbackBase}/runner-bundle.tgz`)} -o /tmp/rb.tgz && ` +
      `tar -xzf /tmp/rb.tgz -C /opt/runner`;
    // sudo: /opt is root-owned, and the runner (also root) must be able to
    // read what we extract here.
    const bootstrapResult = await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", bootstrapCmd],
      sudo: true,
    });
    if (bootstrapResult.exitCode !== 0) {
      throw new Error(`runner bundle bootstrap failed (exit ${bootstrapResult.exitCode})`);
    }

    // Launch via the SDK's structured runCommand + a real env map (issue
    // #23 finding C): secrets travel exclusively through `env`, never
    // interpolated into a command string or shell argv, so they never show
    // up in sandbox command metadata/logs. `detached: true` returns
    // immediately without waiting for the runner process to exit.
    const runnerEnv: Record<string, string> = {
      RUN_ID: run.id,
      CALLBACK_BASE: callbackBase,
      RUNNER_CALLBACK_SECRET: runnerCallbackSecret,
      AI_GATEWAY_API_KEY: aiGatewayApiKey,
      SYSTEM_PROMPT_B64: systemPromptB64,
      BUDGET_CAP_USD: budgetCapUsd,
      TASKS_JSON_B64: tasksJsonB64,
    };
    // sudo: the runner starts dockerd, which requires root; the docker CLI
    // it then drives also needs root to reach the root-owned socket. Running
    // the whole runner as root is simpler and matches the manual `vercel
    // sandbox exec --sudo` path the pipeline was validated against.
    await sandbox.runCommand({
      cmd: "node",
      args: ["/opt/runner/scripts/runner/runner.mjs"],
      env: runnerEnv,
      detached: true,
      sudo: true,
    });

    return { sandbox_id: sandbox.name };
  } catch (err) {
    await markFailed(run, err);
    throw err;
  }
}
