import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const SWE_TASKS_DIR = path.join(process.cwd(), "tasks-swe");

// A vendored SWE-bench-style task spec. The agent receives repo@base_commit
// plus issue_text; the platform extracts its patch and verifies by applying it
// to a clean checkout and running the repo's own test suite:
//   - every test in fail_to_pass must go red -> green
//   - every test in pass_to_pass must stay green
// Gold/test patches are never vendored; the canary GUID line is preserved
// byte-identical for upstream provenance audits.
export const SweTaskSchema = z.object({
  id: z.string().min(1),
  repo: z.string().regex(/^[^/]+\/[^/]+$/, "must be owner/name"),
  base_commit: z.string().regex(/^[0-9a-f]{40}$/, "must be a full sha"),
  issue_text: z.string().min(1),
  // Prebuilt image with repo deps installed at base_commit -- installing deps
  // per-run is too slow/expensive to be part of the agent's budget.
  docker_image: z.string().min(1),
  // Repo-relative directory the agent starts in (some instances need a
  // subdirectory as the project root).
  workdir: z.string().default("/repo"),
  install_cmd: z.string().default(""),
  // Command that runs the instance's test suite inside the container. The
  // platform runs this from a CLEAN copy with the patch applied -- the agent
  // never controls it.
  test_cmd: z.string().min(1),
  fail_to_pass: z.array(z.string()).min(1),
  pass_to_pass: z.array(z.string()),
  // Upstream provenance canary, preserved byte-identical from the source
  // dataset (mirrors terminal-bench's canary GUID convention).
  canary: z.string().min(1),
  agent_timeout_sec: z.number().positive(),
  verifier_timeout_sec: z.number().positive(),
  cpus: z.number().positive(),
  memory: z.string().min(1),
});
export type SweTask = z.infer<typeof SweTaskSchema>;

// The runner-facing shape derived from a spec: what gets baked into
// TASKS_JSON_B64 for a swe-bench run. Kept separate from SweTaskSchema so the
// vendored spec stays the single source of truth and the runner contract stays
// explicit about which fields it consumes.
export interface SweRunnerTask {
  id: string;
  dockerImage: string;
  instruction: string;
  agentTimeoutSec: number;
  verifierTimeoutSec: number;
  cpus: number;
  memory: string;
  workdir: string;
  installCmd: string;
  testCmd: string;
}

export function toRunnerTask(spec: SweTask): SweRunnerTask {
  return {
    id: spec.id,
    dockerImage: spec.docker_image,
    instruction: spec.issue_text,
    agentTimeoutSec: spec.agent_timeout_sec,
    verifierTimeoutSec: spec.verifier_timeout_sec,
    cpus: spec.cpus,
    memory: spec.memory,
    workdir: spec.workdir,
    installCmd: spec.install_cmd,
    testCmd: spec.test_cmd,
  };
}

/**
 * Builds the shell pipeline the verifier runs on the clean copy:
 * apply the agent's patch, then the test command. Exits non-zero unless the
 * patch applies cleanly AND the test command exits 0 -- pass/fail signal is
 * the exit code, reward attribution happens via the FAIL_TO_PASS/PASS_TO_PASS
 * lists parsed from the test output by the runner.
 */
export function buildVerifyCommand(patchPath: string, spec: Pick<SweTask, "workdir" | "test_cmd">): string {
  return `git apply --check '${patchPath}' && git apply '${patchPath}' && cd '${spec.workdir}' && ${spec.test_cmd}`;
}

function loadSweSpec(id: string, tasksDir: string): SweTask {
  const specPath = path.join(tasksDir, `${id}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read/parse task spec for "${id}" at "${specPath}": ${(err as Error).message}`);
  }
  const parsed = SweTaskSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid SWE task spec for "${id}": ${parsed.error.message}`);
  }
  return parsed.data;
}

function listSweTaskIds(tasksDir: string): string[] {
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function getSweTasks(tasksDir: string = SWE_TASKS_DIR): SweTask[] {
  return listSweTaskIds(tasksDir).map((id) => loadSweSpec(id, tasksDir));
}

export function getSweTask(id: string, tasksDir: string = SWE_TASKS_DIR): SweTask {
  if (!listSweTaskIds(tasksDir).includes(id)) {
    throw new Error(`Unknown SWE task id: "${id}"`);
  }
  return loadSweSpec(id, tasksDir);
}
