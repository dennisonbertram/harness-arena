import { describe, expect, it, vi } from "vitest";
import { buildRunnerTasks, sweToRunnerTask } from "./tasks-for-runner";
import type { SweTask } from "./swe-task";

vi.mock("./tasks", () => ({
  getTasks: () => [
    {
      id: "tb-1",
      dockerImage: "tb-image",
      instruction: "do tb thing",
      agentTimeoutSec: 300,
      verifierTimeoutSec: 600,
    },
  ],
}));

const spec: SweTask = {
  id: "swe-1",
  repo: "owner/name",
  base_commit: "a".repeat(40),
  issue_text: "fix the bug described in this issue",
  docker_image: "swe-image",
  workdir: "/repo",
  install_cmd: "",
  test_cmd: "pytest -q",
  test_patch: "",
  fail_to_pass: ["tests/test_a.py::test_new"],
  pass_to_pass: ["tests/test_b.py::test_keep"],
  canary: "canary-guid",
  agent_timeout_sec: 1800,
  verifier_timeout_sec: 1800,
  cpus: 4,
  memory: "8GB",
};

const sweLoader = vi.fn(() => [spec]);

describe("sweToRunnerTask", () => {
  it("maps a vendored SWE spec into the runner's snake_case contract", () => {
    expect(sweToRunnerTask(spec)).toEqual({
      id: "swe-1",
      image: "swe-image",
      instruction: "fix the bug described in this issue",
      agent_timeout_sec: 1800,
      verifier_timeout_sec: 1800,
      benchmark: "swe-bench",
      repo: "owner/name",
      base_commit: "a".repeat(40),
      workdir: "/repo",
      install_cmd: "",
      test_cmd: "pytest -q",
      fail_to_pass: ["tests/test_a.py::test_new"],
      pass_to_pass: ["tests/test_b.py::test_keep"],
      test_patch: "",
    });
  });
});

describe("buildRunnerTasks mode dispatch", () => {
  it("defaults to terminal-bench tasks when RUN_MODE is unset", () => {
    const tasks = buildRunnerTasks({} as NodeJS.ProcessEnv);
    expect(tasks).toMatchObject([{ id: "tb-1", image: "tb-image" }]);
    expect(tasks[0].benchmark).toBeUndefined();
    expect(sweLoader).not.toHaveBeenCalled();
  });

  it("serves vendored SWE specs when RUN_MODE=swe", () => {
    const tasks = buildRunnerTasks({ RUN_MODE: "swe" } as unknown as NodeJS.ProcessEnv, {
      getSweTasks: sweLoader,
    });
    expect(sweLoader).toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: "swe-1", benchmark: "swe-bench" });
  });
});
