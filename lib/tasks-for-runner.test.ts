import { describe, expect, it } from "vitest";
import { buildRunnerTasks } from "./tasks-for-runner";
import { getTasks } from "./tasks";

describe("buildRunnerTasks", () => {
  it("maps every getTasks() entry to the runner's TASKS_JSON shape", () => {
    const tasks = getTasks();
    const runnerTasks = buildRunnerTasks();

    expect(runnerTasks).toHaveLength(tasks.length);
    expect(runnerTasks).toEqual(
      tasks.map((t) => ({
        id: t.id,
        image: t.dockerImage,
        instruction: t.instruction,
        agent_timeout_sec: t.agentTimeoutSec,
        verifier_timeout_sec: t.verifierTimeoutSec,
      })),
    );
  });

  it("uses the runner's snake_case env-contract keys (agent_timeout_sec, verifier_timeout_sec), not the internal camelCase names", () => {
    const [first] = buildRunnerTasks();
    expect(first).toHaveProperty("agent_timeout_sec");
    expect(first).toHaveProperty("verifier_timeout_sec");
    expect(first).not.toHaveProperty("agentTimeoutSec");
    expect(first).not.toHaveProperty("verifierTimeoutSec");
  });
});

describe("regression: image field carries the full docker_image tag runner.mjs passes straight to `docker run`", () => {
  it("every task's image matches alexgshaw/<id>:20251031", () => {
    for (const task of buildRunnerTasks()) {
      expect(task.image).toBe(`alexgshaw/${task.id}:20251031`);
    }
  });
});
