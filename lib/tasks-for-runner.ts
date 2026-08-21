import { getTasks } from "./tasks";
import { getSweTasks, type SweTask } from "./swe-task";

// Maps lib/tasks.ts#getTasks() (terminal-bench) and lib/swe-task.ts#getSweTasks()
// (swe-bench) into the TASKS_JSON_B64 shape runner.mjs expects (see
// callback-contract.md "Runner input"): snake_case keys, the task's docker
// image, and the two timeouts the runner enforces per stage. SWE tasks carry
// extra fields (benchmark, base_commit, test_cmd, ...) that runner.mjs uses to
// dispatch into the swe flow; terminal-bench rows leave them absent.
export interface RunnerTask {
  id: string;
  image: string;
  instruction: string;
  agent_timeout_sec: number;
  verifier_timeout_sec: number;
  benchmark?: "terminal-bench-2" | "swe-bench";
  repo?: string;
  base_commit?: string;
  workdir?: string;
  install_cmd?: string;
  test_cmd?: string;
  fail_to_pass?: string[];
  pass_to_pass?: string[];
  // Public upstream test patch, applied only in the verify phase on a clean
  // copy. Never exposed to the agent container during the agent session.
  test_patch?: string;
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

function agentTimeoutCap(env: NodeJS.ProcessEnv): number {
  return timeoutCap(env.RUNNER_AGENT_TIMEOUT_CAP, DEFAULT_TIMEOUT_CAP_SEC);
}

function verifyTimeoutCap(env: NodeJS.ProcessEnv): number {
  return timeoutCap(env.RUNNER_VERIFY_TIMEOUT_CAP, DEFAULT_TIMEOUT_CAP_SEC);
}

export function sweToRunnerTask(
  spec: SweTask,
  env: NodeJS.ProcessEnv = process.env,
): RunnerTask {
  return {
    id: spec.id,
    image: spec.docker_image,
    instruction: spec.issue_text,
    agent_timeout_sec: Math.min(spec.agent_timeout_sec, agentTimeoutCap(env)),
    verifier_timeout_sec: Math.min(spec.verifier_timeout_sec, verifyTimeoutCap(env)),
    benchmark: "swe-bench",
    repo: spec.repo,
    base_commit: spec.base_commit,
    workdir: spec.workdir,
    install_cmd: spec.install_cmd,
    test_cmd: spec.test_cmd,
    fail_to_pass: spec.fail_to_pass,
    pass_to_pass: spec.pass_to_pass,
    test_patch: spec.test_patch,
  };
}

// Mode selection for a run. RUN_MODE=swe (set platform-side by the swe-bench
// dispatch) serves the vendored SWE specs instead of the terminal-bench tasks.
// The runner independently re-derives its mode from the payload's benchmark
// fields (scripts/runner/gateway-proxy.mjs resolveRunMode), so the two sides
// agree even if only one of them is configured correctly.
export function buildRunnerTasks(
  env: NodeJS.ProcessEnv = process.env,
  loaders: { getSweTasks?: typeof getSweTasks } = {},
): RunnerTask[] {
  if ((env.RUN_MODE ?? "").trim() === "swe") {
    const loadSwe = loaders.getSweTasks ?? getSweTasks;
    return loadSwe().map((spec) => sweToRunnerTask(spec, env));
  }
  return getTasks().map((task) => ({
    id: task.id,
    image: task.dockerImage,
    instruction: task.instruction,
    agent_timeout_sec: Math.min(task.agentTimeoutSec, agentTimeoutCap(env)),
    verifier_timeout_sec: Math.min(task.verifierTimeoutSec, verifyTimeoutCap(env)),
  }));
}
