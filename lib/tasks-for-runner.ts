import { getTasks } from "./tasks";

// Maps lib/tasks.ts#getTasks() into the TASKS_JSON_B64 shape runner.mjs
// expects (see callback-contract.md "Runner input"): snake_case keys, the
// task's docker image, and the two timeouts the runner enforces per stage.
export interface RunnerTask {
  id: string;
  image: string;
  instruction: string;
  agent_timeout_sec: number;
  verifier_timeout_sec: number;
}

// Real task.toml agent/verifier timeouts (900s each) were built for a
// long-running human-facing harness, not this sandbox's budget. Capping
// both per task (issue #23 finding E) bounds worst-case run duration to
// ~10 tasks x (300+240)s =~ 90 minutes, safely under the 120-minute
// sandbox timeout -- the $2 budget cap aborts most runs far earlier anyway.
const DEFAULT_AGENT_TIMEOUT_CAP_SEC = 300;
const DEFAULT_VERIFY_TIMEOUT_CAP_SEC = 240;

function timeoutCap(envValue: string | undefined, hardCeiling: number): number {
  if (envValue === undefined) return hardCeiling;
  const configured = Number(envValue);
  if (!Number.isFinite(configured) || configured <= 0) return hardCeiling;
  return Math.min(configured, hardCeiling);
}

function agentTimeoutCap(): number {
  return timeoutCap(process.env.RUNNER_AGENT_TIMEOUT_CAP, DEFAULT_AGENT_TIMEOUT_CAP_SEC);
}

function verifyTimeoutCap(): number {
  return timeoutCap(process.env.RUNNER_VERIFY_TIMEOUT_CAP, DEFAULT_VERIFY_TIMEOUT_CAP_SEC);
}

export function buildRunnerTasks(): RunnerTask[] {
  return getTasks().map((task) => ({
    id: task.id,
    image: task.dockerImage,
    instruction: task.instruction,
    agent_timeout_sec: Math.min(task.agentTimeoutSec, agentTimeoutCap()),
    verifier_timeout_sec: Math.min(task.verifierTimeoutSec, verifyTimeoutCap()),
  }));
}
