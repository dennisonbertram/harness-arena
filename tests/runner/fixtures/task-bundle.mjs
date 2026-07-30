// Builds a throwaway RUNNER_TASKS_DIR bundle for a test, keyed by a
// caller-supplied unique task id rather than the source task's real folder
// name. This lets integration/regression test files each use their own
// container name (task-<id>) so they never collide with each other when
// vitest runs multiple test files in parallel workers.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function buildTaskBundleDir(repoRoot, uniqueTaskId, sourceTaskId = "regex-log") {
  const root = mkdtempSync(path.join(tmpdir(), "runner-tasks-bundle-"));
  const taskDir = path.join(root, uniqueTaskId);
  const sourceTests = path.join(repoRoot, "tasks", sourceTaskId, "tests");
  const testsDir = path.join(taskDir, "tests");
  mkdirSync(testsDir, { recursive: true });

  if (existsSync(sourceTests)) {
    cpSync(sourceTests, testsDir, { recursive: true });
  } else {
    // Some historical runner fixtures use the retired regex-log image, whose
    // grading files are intentionally absent from the public task bundle.
    // Keep those integration tests independent of private grading material
    // with a deterministic test-only verifier.
    writeFileSync(
      path.join(testsDir, "test.sh"),
      [
        "#!/usr/bin/env bash",
        "set -e",
        "mkdir -p /logs/verifier",
        "printf '0' > /logs/verifier/reward.txt",
        "printf 'synthetic runner fixture verifier\\n'",
        "",
      ].join("\n"),
    );
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
