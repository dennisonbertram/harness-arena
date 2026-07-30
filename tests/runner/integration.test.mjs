// Full runner pipeline against real local Docker + the real fix-git task
// image, with PI_INVOKE_OVERRIDE pointing at a deterministic fake-pi
// fixture that writes an intentionally WRONG answer. This proves the pipeline
// (docker lifecycle, agent kit injection, cost parsing, verification,
// reward.txt parsing, trace upload, event sequence, final totals)
// completes correctly end to end -- pipeline correctness is asserted via
// passed=false, independent of a real "correct answer" happy path.
//
// Guarded: only runs with RUNNER_IT=1 (see PR description). Set
// RUNNER_IT_VERBOSE=1 to also print the runner's stdout/stderr.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildContainerName } from "../../scripts/runner/lib.mjs";
import { startCallbackServer } from "./fixtures/callback-server.mjs";
import { buildTaskBundleDir } from "./fixtures/task-bundle.mjs";

const RUNNER_IT = process.env.RUNNER_IT === "1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RUNNER_SCRIPT = path.join(REPO_ROOT, "scripts", "runner", "runner.mjs");
// Runner integration files execute in parallel workers. Each runner owns one
// host-side gateway proxy, so file-specific ports prevent preflight collisions.
const TEST_GATEWAY_PROXY_PORT = "14598";
// Unique per test file (not just "fix-git") so this suite's container
// name never collides with other tests/runner/*.test.mjs files that also
// exercise the fix-git image concurrently under vitest's file parallelism.
const TASK_ID = "fix-git-it";
const RUN_ID = "it-run-1";
// Container name now includes RUN_ID + index (issue #19 finding 6) so
// concurrent runs can never force-remove each other's containers.
const CONTAINER_NAME = buildContainerName(RUN_ID, 0, TASK_ID);
const cleanupDirs = new Set();

function cleanupContainer() {
  try {
    execFileSync("docker", ["rm", "-f", CONTAINER_NAME], { stdio: "ignore" });
  } catch {
    // container may not exist -- fine
  }
}

afterEach(() => {
  cleanupContainer();
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs.clear();
});

describe.skipIf(!RUNNER_IT)("runner integration (RUNNER_IT=1, real local docker)", () => {
  it(
    "drives the real fix-git task through fake-pi with a WRONG answer end to end",
    async () => {
      cleanupContainer();

      // Build a fixture agentkit tarball containing fake-pi.sh extracted to
      // /usr/local/bin/fake-pi.sh, mirroring the real agentkit.tgz -> /usr/local layout.
      const tgzRoot = mkdtempSync(path.join(tmpdir(), "agentkit-fixture-"));
      cleanupDirs.add(tgzRoot);
      mkdirSync(path.join(tgzRoot, "bin"), { recursive: true });
      const fakePiSrc = readFileSync(path.join(__dirname, "fixtures", "fake-pi.sh"));
      const fakePiDest = path.join(tgzRoot, "bin", "fake-pi.sh");
      writeFileSync(fakePiDest, fakePiSrc);
      chmodSync(fakePiDest, 0o755);
      const agentkitTgz = path.join(tgzRoot, "agentkit.tgz");
      execFileSync("tar", ["-czf", agentkitTgz, "-C", tgzRoot, "bin"]);

      const gradingSource = buildTaskBundleDir(REPO_ROOT, TASK_ID, "fix-git");
      cleanupDirs.add(gradingSource.root);
      const fetchedTasksRoot = mkdtempSync(path.join(tmpdir(), "runner-fetched-tests-"));
      cleanupDirs.add(fetchedTasksRoot);
      const { state, baseUrl, stop } = await startCallbackServer({
        secret: "test-secret",
        tasksRoot: gradingSource.root,
      });

      const instruction = readFileSync(
        path.join(REPO_ROOT, "tasks", "fix-git", "instruction.md"),
        "utf8",
      );
      const tasks = [
        {
          id: TASK_ID,
          image: "alexgshaw/fix-git:20251031",
          instruction,
          agent_timeout_sec: 60,
          verifier_timeout_sec: 300,
        },
      ];

      const env = {
        ...process.env,
        RUN_ID,
        CALLBACK_BASE: baseUrl,
        GATEWAY_PROXY_PORT: TEST_GATEWAY_PROXY_PORT,
        RUNNER_CALLBACK_SECRET: "test-secret",
        AI_GATEWAY_API_KEY: "test-gateway-key",
        GATEWAY_UPSTREAM: baseUrl,
        SYSTEM_PROMPT_B64: Buffer.from("You are a helpful coding agent.", "utf8").toString(
          "base64",
        ),
        BUDGET_CAP_USD: "2",
        TASKS_JSON_B64: Buffer.from(JSON.stringify(tasks), "utf8").toString("base64"),
        RUNNER_TASKS_DIR: fetchedTasksRoot,
        AGENTKIT_TGZ: agentkitTgz,
        PI_INVOKE_OVERRIDE: "/usr/local/bin/fake-pi.sh",
      };
      delete env.PI_INSTALL_MODE;

      const exitCode = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [RUNNER_SCRIPT], { env });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code) => {
          if (process.env.RUNNER_IT_VERBOSE === "1") {
            console.log("runner stdout:\n" + stdout);
            console.log("runner stderr:\n" + stderr);
          }
          resolve(code);
        });
      });

      await stop();

      expect(exitCode).toBe(0);
      const fetchedTestScript = path.join(fetchedTasksRoot, TASK_ID, "tests", "test.sh");
      expect(
        existsSync(fetchedTestScript),
        `runner did not fetch grading tests; events=${JSON.stringify(state.events)}`,
      ).toBe(true);
      expect(readFileSync(fetchedTestScript, "utf8").trim().length).toBeGreaterThan(0);
      expect(state.testFetches).toBe(1);

      // First status transition must be "running", posted right after
      // run.sandbox_ready and before any task work starts (issue #23
      // finding B) -- a run must never sit at "queued" until its terminal
      // status.
      expect(state.statusUpdates[0]?.status).toBe("running");

      const eventTypes = state.events.map((e) => e.type);
      expect(eventTypes).toContain("run.sandbox_ready");
      expect(eventTypes).toContain("task.started");
      expect(eventTypes).toContain("task.agent_finished");
      expect(eventTypes).toContain("task.verify_started");
      expect(eventTypes).toContain("task.verified");
      expect(eventTypes).toContain("task.trace_uploaded");
      expect(eventTypes).toContain("run.completed");

      // seq is monotonically increasing in post order (API-assigned per taxonomy).
      const seqs = state.events.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

      const agentFinished = state.events.find((e) => e.type === "task.agent_finished");
      expect(agentFinished.payload.task_id).toBe(TASK_ID);
      expect(agentFinished.payload.turns).toBe(2);
      expect(agentFinished.payload.cost_usd).toBeCloseTo(0.003, 6);
      // Session file was readable, so cost came from the session, not the
      // tamper-resistance floor (issue #19 finding 2).
      expect(agentFinished.payload.cost_source).toBe("session");

      const verified = state.events.find((e) => e.type === "task.verified");
      expect(verified.payload.task_id).toBe(TASK_ID);
      expect(verified.payload.passed).toBe(false);
      expect(verified.payload.reward).toBe(0);

      const traceUploadEvents = state.events.filter((e) => e.type === "task.trace_uploaded");
      expect(traceUploadEvents.length).toBeGreaterThanOrEqual(2);

      const traceNames = state.traces.map((t) => t.name);
      expect(traceNames).toContain("session.jsonl");
      expect(traceNames).toContain("pi-stdout.txt");
      expect(traceNames).toContain("runner-log.txt");

      const sessionTrace = state.traces.find((t) => t.name === "session.jsonl");
      expect(gunzipSync(sessionTrace.body).toString("utf8")).toContain('"total":0.001');

      const finalStatus = state.statusUpdates.at(-1);
      expect(finalStatus.status).toBe("completed");
      expect(finalStatus.totals.tasks_passed).toBe(0);
      expect(finalStatus.totals.total_cost_usd).toBeCloseTo(0.003, 6);
      expect(finalStatus.totals.over_budget).toBe(false);
      expect(finalStatus.task_results).toHaveLength(1);
      expect(finalStatus.task_results[0]).toMatchObject({
        task_id: TASK_ID,
        attempted: true,
        passed: false,
      });

      // Container cleanup on the success path (issue #19 finding 5): the
      // per-task container must not be left running/present after the run
      // completes.
      let containerStillExists = true;
      try {
        execFileSync("docker", ["inspect", CONTAINER_NAME], { stdio: "ignore" });
      } catch {
        containerStillExists = false;
      }
      expect(containerStillExists).toBe(false);

    },
    600000,
  );
});
