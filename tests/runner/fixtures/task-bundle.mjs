// Builds a throwaway RUNNER_TASKS_DIR bundle for a test, keyed by a
// caller-supplied unique task id rather than the real "regex-log" folder
// name. This lets integration/regression test files each use their own
// container name (task-<id>) so they never collide with each other when
// vitest runs multiple test files in parallel workers.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function buildTaskBundleDir(repoRoot, uniqueTaskId) {
  const root = mkdtempSync(path.join(tmpdir(), "runner-tasks-bundle-"));
  const taskDir = path.join(root, uniqueTaskId);
  mkdirSync(taskDir, { recursive: true });
  cpSync(path.join(repoRoot, "tasks", "regex-log", "tests"), path.join(taskDir, "tests"), {
    recursive: true,
  });
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
