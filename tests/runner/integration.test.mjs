// Full runner pipeline against real local Docker + the real regex-log task
// image, with PI_INVOKE_OVERRIDE pointing at a deterministic fake-pi
// fixture that writes a WRONG regex.txt answer. This proves the pipeline
// (docker lifecycle, agent kit injection, cost parsing, verification,
// reward.txt parsing, trace upload, event sequence, final totals)
// completes correctly end to end -- pipeline correctness is asserted via
// passed=false, independent of a real "correct answer" happy path.
//
// Guarded: only runs with RUNNER_IT=1 (see PR description). Set
// RUNNER_IT_VERBOSE=1 to also print the runner's stdout/stderr.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startCallbackServer } from "./fixtures/callback-server.mjs";
import { buildTaskBundleDir } from "./fixtures/task-bundle.mjs";

const RUNNER_IT = process.env.RUNNER_IT === "1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RUNNER_SCRIPT = path.join(REPO_ROOT, "scripts", "runner", "runner.mjs");
// Unique per test file (not just "regex-log") so this suite's container
// name never collides with other tests/runner/*.test.mjs files that also
// exercise the regex-log image concurrently under vitest's file parallelism.
const TASK_ID = "regex-log-it";
const CONTAINER_NAME = `task-${TASK_ID}`;

function cleanupContainer() {
  try {
    execFileSync("docker", ["rm", "-f", CONTAINER_NAME], { stdio: "ignore" });
  } catch {
    // container may not exist -- fine
  }
}

afterEach(() => {
  cleanupContainer();
});

describe.skipIf(!RUNNER_IT)("runner integration (RUNNER_IT=1, real local docker)", () => {
  it(
    "drives the real regex-log task through fake-pi with a WRONG answer end to end",
    async () => {
      cleanupContainer();

      // Build a fixture agentkit tarball containing fake-pi.sh extracted to
      // /usr/local/bin/fake-pi.sh, mirroring the real agentkit.tgz -> /usr/local layout.
      const tgzRoot = mkdtempSync(path.join(tmpdir(), "agentkit-fixture-"));
      mkdirSync(path.join(tgzRoot, "bin"), { recursive: true });
      const fakePiSrc = readFileSync(path.join(__dirname, "fixtures", "fake-pi.sh"));
      const fakePiDest = path.join(tgzRoot, "bin", "fake-pi.sh");
      writeFileSync(fakePiDest, fakePiSrc);
      chmodSync(fakePiDest, 0o755);
      const agentkitTgz = path.join(tgzRoot, "agentkit.tgz");
      execFileSync("tar", ["-czf", agentkitTgz, "-C", tgzRoot, "bin"]);

      const { state, baseUrl, stop } = await startCallbackServer({ secret: "test-secret" });
      const bundle = buildTaskBundleDir(REPO_ROOT, TASK_ID);

      const instruction = readFileSync(
        path.join(REPO_ROOT, "tasks", "regex-log", "instruction.md"),
        "utf8",
      );
      const tasks = [
        {
          id: TASK_ID,
          image: "alexgshaw/regex-log:20251031",
          instruction,
          agent_timeout_sec: 60,
          verifier_timeout_sec: 300,
        },
      ];

      const env = {
        ...process.env,
        RUN_ID: "it-run-1",
        CALLBACK_BASE: baseUrl,
        RUNNER_CALLBACK_SECRET: "test-secret",
        AI_GATEWAY_API_KEY: "test-gateway-key",
        SYSTEM_PROMPT_B64: Buffer.from("You are a helpful coding agent.", "utf8").toString(
          "base64",
        ),
        BUDGET_CAP_USD: "2",
        TASKS_JSON_B64: Buffer.from(JSON.stringify(tasks), "utf8").toString("base64"),
        RUNNER_TASKS_DIR: bundle.root,
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
      rmSync(tgzRoot, { recursive: true, force: true });

      expect(exitCode).toBe(0);

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
      expect(sessionTrace.body.toString("utf8")).toContain('"total":0.001');

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

      bundle.cleanup();
    },
    600000,
  );
});
