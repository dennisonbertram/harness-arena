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

// task.toml is the benchmark contract. Do not silently shorten its stage
// windows: live evidence showed valid QEMU/PyTorch solutions completing close
// to the old five-minute arena cap, while other tasks explicitly allow up to
// 30 minutes. Operators may tighten a window for a controlled experiment via
// env, but the default preserves each task's own limit.
const DEFAULT_TIMEOUT_CAP_SEC = Number.POSITIVE_INFINITY;

function timeoutCap(envValue: string | undefined, hardCeiling: number): number {
  if (envValue === undefined) return hardCeiling;
  const configured = Number(envValue);
  if (!Number.isFinite(configured) || configured <= 0) return hardCeiling;
  return Math.min(configured, hardCeiling);
}

function agentTimeoutCap(): number {
  return timeoutCap(process.env.RUNNER_AGENT_TIMEOUT_CAP, DEFAULT_TIMEOUT_CAP_SEC);
}

function verifyTimeoutCap(): number {
  return timeoutCap(process.env.RUNNER_VERIFY_TIMEOUT_CAP, DEFAULT_TIMEOUT_CAP_SEC);
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
