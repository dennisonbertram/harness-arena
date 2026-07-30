import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunnerTasks } from "./tasks-for-runner";
import { getTasks } from "./tasks";

describe("buildRunnerTasks", () => {
  it("maps every getTasks() entry to the runner's TASKS_JSON shape, capping the two timeouts", () => {
    const tasks = getTasks();
    const runnerTasks = buildRunnerTasks();

    expect(runnerTasks).toHaveLength(tasks.length);
    expect(runnerTasks).toEqual(
      tasks.map((t) => ({
        id: t.id,
        image: t.dockerImage,
        instruction: t.instruction,
        agent_timeout_sec: Math.min(t.agentTimeoutSec, 300),
        verifier_timeout_sec: Math.min(t.verifierTimeoutSec, 240),
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

describe("timeout caps (issue #23 finding E): bound worst-case run duration under the 120-minute sandbox timeout", () => {
  it("caps agent_timeout_sec at 300s even though the real task.toml values are 900s", () => {
    const tasks = getTasks();
    // Sanity-check the fixture assumption this test relies on: every real
    // task's source timeout exceeds the cap, so capping is actually
    // exercised here (not vacuously true).
    expect(tasks.every((t) => t.agentTimeoutSec > 300)).toBe(true);

    for (const runnerTask of buildRunnerTasks()) {
      expect(runnerTask.agent_timeout_sec).toBe(300);
    }
  });

  it("caps verifier_timeout_sec at 240s even though the real task.toml values are 900s", () => {
    const tasks = getTasks();
    expect(tasks.every((t) => t.verifierTimeoutSec > 240)).toBe(true);

    for (const runnerTask of buildRunnerTasks()) {
      expect(runnerTask.verifier_timeout_sec).toBe(240);
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

    it("does not let an environment override loosen the hard timeout ceilings", () => {
      process.env.RUNNER_AGENT_TIMEOUT_CAP = "900";
      process.env.RUNNER_VERIFY_TIMEOUT_CAP = "900";

      for (const runnerTask of buildRunnerTasks()) {
        expect(runnerTask.agent_timeout_sec).toBe(300);
        expect(runnerTask.verifier_timeout_sec).toBe(240);
      }
    });
  });
});
