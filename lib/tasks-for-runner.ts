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

export function buildRunnerTasks(): RunnerTask[] {
  return getTasks().map((task) => ({
    id: task.id,
    image: task.dockerImage,
    instruction: task.instruction,
    agent_timeout_sec: task.agentTimeoutSec,
    verifier_timeout_sec: task.verifierTimeoutSec,
  }));
}
