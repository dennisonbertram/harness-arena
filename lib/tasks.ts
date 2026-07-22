import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const TASKS_DIR = path.join(process.cwd(), "tasks");

// Zod schema for the subset of task.toml fields this loader consumes.
// Note: at the pinned upstream commit, task.toml has no `[task]` / `name`
// field and `environment.memory` / `environment.storage` are human-readable
// strings (e.g. "2G"), not `memory_mb` integers. The loader models the
// fields as they actually exist upstream rather than a newer schema.
const TaskTomlSchema = z.object({
  verifier: z.object({
    timeout_sec: z.number().positive(),
  }),
  agent: z.object({
    timeout_sec: z.number().positive(),
  }),
  environment: z.object({
    docker_image: z.string().min(1),
    cpus: z.number().positive(),
    memory: z.string().min(1),
  }),
});

export interface Task {
  id: string;
  dockerImage: string;
  instruction: string;
  agentTimeoutSec: number;
  verifierTimeoutSec: number;
  cpus: number;
  memory: string;
  testsDir: string;
}

function loadTask(id: string): Task {
  const taskDir = path.join(TASKS_DIR, id);
  const tomlPath = path.join(taskDir, "task.toml");
  const instructionPath = path.join(taskDir, "instruction.md");

  let raw: unknown;
  try {
    raw = parseToml(readFileSync(tomlPath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read/parse task.toml for task "${id}": ${(err as Error).message}`);
  }

  const parsed = TaskTomlSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid task.toml for task "${id}": ${parsed.error.message}`);
  }

  const instruction = readFileSync(instructionPath, "utf8");

  const expectedImage = `alexgshaw/${id}:20251031`;
  if (parsed.data.environment.docker_image !== expectedImage) {
    throw new Error(
      `Task "${id}" docker_image "${parsed.data.environment.docker_image}" does not match expected "${expectedImage}"`,
    );
  }

  return {
    id,
    dockerImage: parsed.data.environment.docker_image,
    instruction,
    agentTimeoutSec: parsed.data.agent.timeout_sec,
    verifierTimeoutSec: parsed.data.verifier.timeout_sec,
    cpus: parsed.data.environment.cpus,
    memory: parsed.data.environment.memory,
    testsDir: path.join(taskDir, "tests"),
  };
}

function listTaskIds(): string[] {
  return readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function getTasks(): Task[] {
  return listTaskIds().map(loadTask);
}

export function getTask(id: string): Task {
  if (!listTaskIds().includes(id)) {
    throw new Error(`Unknown task id: "${id}"`);
  }
  return loadTask(id);
}
