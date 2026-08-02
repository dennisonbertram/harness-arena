import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunnerTasks } from "./tasks-for-runner";
import { getTasks } from "./tasks";

describe("buildRunnerTasks", () => {
  it("maps every getTasks() entry to the runner's TASKS_JSON shape with its benchmark timeouts", () => {
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

describe("timeout caps: preserve each benchmark-defined task window by default", () => {
  it("does not cut the benchmark's 10-30 minute stage timeouts down to five minutes", () => {
    const tasks = getTasks();
    expect(Math.min(...tasks.map((t) => t.agentTimeoutSec))).toBe(600);
    expect(Math.max(...tasks.map((t) => t.agentTimeoutSec))).toBe(1800);

    for (const [index, runnerTask] of buildRunnerTasks().entries()) {
      expect(runnerTask.agent_timeout_sec).toBe(tasks[index].agentTimeoutSec);
      expect(runnerTask.verifier_timeout_sec).toBe(tasks[index].verifierTimeoutSec);
    }
  });

  describe("RUNNER_AGENT_TIMEOUT_CAP / RUNNER_VERIFY_TIMEOUT_CAP env overrides", () => {
    const ORIGINAL_AGENT_CAP = process.env.RUNNER_AGENT_TIMEOUT_CAP;
    const ORIGINAL_VERIFY_CAP = process.env.RUNNER_VERIFY_TIMEOUT_CAP;

    afterEach(() => {
      if (ORIGINAL_AGENT_CAP === undefined) delete process.env.RUNNER_AGENT_TIMEOUT_CAP;
      else process.env.RUNNER_AGENT_TIMEOUT_CAP = ORIGINAL_AGENT_CAP;
      if (ORIGINAL_VERIFY_CAP === undefined) delete process.env.RUNNER_VERIFY_TIMEOUT_CAP;
      else process.env.RUNNER_VERIFY_TIMEOUT_CAP = ORIGINAL_VERIFY_CAP;
    });

    beforeEach(() => {
      delete process.env.RUNNER_AGENT_TIMEOUT_CAP;
      delete process.env.RUNNER_VERIFY_TIMEOUT_CAP;
    });

    it("honors a tighter RUNNER_AGENT_TIMEOUT_CAP / RUNNER_VERIFY_TIMEOUT_CAP", () => {
      process.env.RUNNER_AGENT_TIMEOUT_CAP = "120";
      process.env.RUNNER_VERIFY_TIMEOUT_CAP = "90";

      for (const runnerTask of buildRunnerTasks()) {
        expect(runnerTask.agent_timeout_sec).toBe(120);
        expect(runnerTask.verifier_timeout_sec).toBe(90);
      }
    });

    it("does not let an environment override exceed each task's benchmark timeout", () => {
      process.env.RUNNER_AGENT_TIMEOUT_CAP = "3600";
      process.env.RUNNER_VERIFY_TIMEOUT_CAP = "3600";

      const tasks = getTasks();
      for (const [index, runnerTask] of buildRunnerTasks().entries()) {
        expect(runnerTask.agent_timeout_sec).toBe(tasks[index].agentTimeoutSec);
        expect(runnerTask.verifier_timeout_sec).toBe(tasks[index].verifierTimeoutSec);
      }
    });
  });
});
