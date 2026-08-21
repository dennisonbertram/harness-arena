import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildVerifyCommand,
  getSweTask,
  getSweTasks,
  toRunnerTask,
  SweTaskSchema,
} from "./swe-task";

const VALID_SPEC = {
  id: "django__django-16379",
  repo: "django/django",
  base_commit: "4a72da71001f71449f70da6f6f1c1ff13aea5c46",
  issue_text: "QuerySet.aggregate() mixes annotate aliases with aggregate aliases.",
  docker_image: "ghcr.io/harness-arena/swe:django__django-16379",
  workdir: "/repo",
  install_cmd: "pip install -e .",
  test_cmd: "python -m pytest -x -q tests/aggregate/tests.py",
  fail_to_pass: ["tests/aggregate/tests.py::test_aggregate_alias"],
  pass_to_pass: ["tests/aggregate/tests.py::test_existing"],
  canary: "swe-bench-canary-GUID",
  agent_timeout_sec: 1800,
  verifier_timeout_sec: 900,
  cpus: 4,
  memory: "8G",
};

describe("SweTaskSchema", () => {
  it("accepts a well-formed spec", () => {
    expect(SweTaskSchema.safeParse(VALID_SPEC).success).toBe(true);
  });

  it("rejects a non-sha base_commit (pins must be exact)", () => {
    const parsed = SweTaskSchema.safeParse({ ...VALID_SPEC, base_commit: "abc123" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty FAIL_TO_PASS list (task would be unverifiable)", () => {
    const parsed = SweTaskSchema.safeParse({ ...VALID_SPEC, fail_to_pass: [] });
    expect(parsed.success).toBe(false);
  });
});

describe("toRunnerTask", () => {
  it("maps the spec onto the runner contract with the issue as instruction", () => {
    const runner = toRunnerTask(SweTaskSchema.parse(VALID_SPEC));
    expect(runner).toEqual({
      id: VALID_SPEC.id,
      dockerImage: VALID_SPEC.docker_image,
      instruction: VALID_SPEC.issue_text,
      agentTimeoutSec: 1800,
      verifierTimeoutSec: 900,
      cpus: 4,
      memory: "8G",
      workdir: "/repo",
      installCmd: "pip install -e .",
      testCmd: VALID_SPEC.test_cmd,
    });
  });
});

describe("buildVerifyCommand", () => {
  it("applies the patch then runs the test command in the workdir", () => {
    const cmd = buildVerifyCommand("/tmp/agent.patch", { workdir: "/repo", test_cmd: "pytest -q" });
    expect(cmd).toContain("git apply --check '/tmp/agent.patch'");
    expect(cmd).toContain("git apply '/tmp/agent.patch'");
    expect(cmd).toContain("cd '/repo'");
    expect(cmd.endsWith("pytest -q")).toBe(true);
  });

  it("chains with && so a failed apply or failing test exits non-zero", () => {
    const cmd = buildVerifyCommand("/p.patch", { workdir: "/repo", test_cmd: "pytest" });
    expect(cmd).toMatch(/--check.*&&.*git apply.*&&.*cd/);
  });
});

describe("loader", () => {
  it("loads specs from a tasks-swe directory and rejects unknown ids", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tasks-swe-"));
    try {
      writeFileSync(path.join(dir, `${VALID_SPEC.id}.json`), JSON.stringify(VALID_SPEC));
      writeFileSync(path.join(dir, "not-a-spec.json"), JSON.stringify({ nope: true }));

      // A file that isn't a valid spec must fail LOUDLY (a corrupt spec
      // shrinks the fixed board silently if skipped).
      expect(() => getSweTasks(dir)).toThrow(/Invalid SWE task spec/);

      const cleanDir = mkdtempSync(path.join(tmpdir(), "tasks-swe-clean-"));
      try {
        writeFileSync(path.join(cleanDir, `${VALID_SPEC.id}.json`), JSON.stringify(VALID_SPEC));
        const tasks = getSweTasks(cleanDir);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].id).toBe(VALID_SPEC.id);
        expect(getSweTask(VALID_SPEC.id, cleanDir)).toEqual(tasks[0]);
      } finally {
        rmSync(cleanDir, { recursive: true, force: true });
      }
      expect(() => getSweTask("missing__task-1", dir)).toThrow(/Unknown SWE task id/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a spec file that fails schema validation with a clear error", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tasks-swe-"));
    try {
      writeFileSync(
        path.join(dir, "broken__repo-1.json"),
        JSON.stringify({ ...VALID_SPEC, id: "broken__repo-1", base_commit: "short" }),
      );
      expect(() => getSweTasks(dir)).toThrow(/Invalid SWE task spec/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
