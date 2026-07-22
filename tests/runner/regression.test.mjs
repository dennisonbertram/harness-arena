// Regression coverage for TASK-6 (issue #6), added after the green
// implementation in c7c7be3. These cover angles the behavioral tests in
// lib.test.mjs / integration.test.mjs do not:
//  1. buildPiCommand's quoting must defeat real shell-injection attempts
//     embedded in an untrusted task instruction (a security-relevant path,
//     not just a "does it look quoted" structural check).
//  2. parseSessionCost must not be poisoned by realistic upstream JSONL
//     noise (tool_result lines, assistant turns with no usage at all, a
//     non-numeric cost.total) -- the exact "schema drift" risk called out
//     in issue #6.
//  3. The runner's budget-abort granularity ("check cumulative cost AFTER
//     a task completes") must let an over-cap task finish and verify, but
//     must never even start a subsequent task once the cap is crossed --
//     guarded (RUNNER_IT=1), real local Docker, second task must produce
//     zero docker/callback activity.
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildContainerName, buildPiCommand, parseSessionCost } from "../../scripts/runner/lib.mjs";
import { startCallbackServer } from "./fixtures/callback-server.mjs";
import { buildTaskBundleDir } from "./fixtures/task-bundle.mjs";

const RUNNER_IT = process.env.RUNNER_IT === "1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RUNNER_SCRIPT = path.join(REPO_ROOT, "scripts", "runner", "runner.mjs");

describe("buildPiCommand regression: shell-injection safety", () => {
  it("does not execute a semicolon/command-substitution injection attempt embedded in the instruction", () => {
    const marker = path.join(tmpdir(), `runner-injection-marker-${Date.now()}`);
    rmSync(marker, { force: true });
    const malicious = `'; touch ${marker}; echo '`;

    const cmd = buildPiCommand({
      agentTimeoutSec: 1,
      sessionDir: "/does/not/exist",
      promptFile: "/does/not/exist",
      instruction: malicious,
    });

    try {
      // Run exactly the way docker exec would: `sh -c "<cmd>"`. The
      // default command targets /usr/local/bin/pi, which won't exist on
      // this host, so the overall exit code is expected to be non-zero --
      // what matters is that the injected `touch` never ran.
      execFileSync("sh", ["-c", cmd]);
    } catch {
      // expected: /usr/local/bin/pi not found on the test host
    }

    expect(existsSync(marker)).toBe(false);
  });
});

describe("parseSessionCost regression: realistic upstream JSONL noise", () => {
  it("ignores tool_result lines, usage-less assistant turns, and non-numeric cost.total without crashing or NaN-poisoning the sum", () => {
    const jsonl = [
      JSON.stringify({ type: "message", message: { role: "user", content: "go" } }),
      JSON.stringify({ type: "tool_call", tool: "bash", input: "ls" }),
      JSON.stringify({ type: "tool_result", output: "file1\nfile2" }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", usage: { cost: { total: 0.01 } } },
      }),
      // Assistant turn with no usage block at all (e.g. a pure tool-call turn).
      JSON.stringify({ type: "message", message: { role: "assistant" } }),
      // Malformed cost shape from a hypothetical future pi version.
      JSON.stringify({
        type: "message",
        message: { role: "assistant", usage: { cost: { total: "not-a-number" } } },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", usage: { cost: { total: 0.02 } } },
      }),
    ].join("\n");

    const result = parseSessionCost(jsonl);
    expect(result.totalCost).toBeCloseTo(0.03, 10);
    expect(Number.isNaN(result.totalCost)).toBe(false);
    expect(result.turns).toBe(4);
  });
});

// Unique per test file so this suite's container names never collide with
// other tests/runner/*.test.mjs files exercising the same image concurrently.
const TASK_ID_1 = "regex-log-budget-1";
const TASK_ID_2 = "regex-log-budget-2";
const BUDGET_RUN_ID = "it-run-budget";
// Container names now include RUN_ID + index (issue #19 finding 6).
const CONTAINER_NAMES = [
  buildContainerName(BUDGET_RUN_ID, 0, TASK_ID_1),
  buildContainerName(BUDGET_RUN_ID, 1, TASK_ID_2),
];
function cleanupContainers() {
  for (const name of CONTAINER_NAMES) {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      // container may not exist -- fine
    }
  }
}

afterEach(() => {
  cleanupContainers();
});

describe.skipIf(!RUNNER_IT)(
  "runner regression (RUNNER_IT=1, real local docker): budget-abort granularity",
  () => {
    it(
      "lets the task that crosses the cap finish and verify, but never starts the next task",
      async () => {
        cleanupContainers();

        const tgzRoot = mkdtempSync(path.join(tmpdir(), "agentkit-fixture-expensive-"));
        mkdirSync(path.join(tgzRoot, "bin"), { recursive: true });
        const fakePiSrc = readFileSync(path.join(__dirname, "fixtures", "fake-pi-expensive.sh"));
        const fakePiDest = path.join(tgzRoot, "bin", "fake-pi.sh");
        writeFileSync(fakePiDest, fakePiSrc);
        chmodSync(fakePiDest, 0o755);
        const agentkitTgz = path.join(tgzRoot, "agentkit.tgz");
        execFileSync("tar", ["-czf", agentkitTgz, "-C", tgzRoot, "bin"]);

        const { state, baseUrl, stop } = await startCallbackServer({ secret: "test-secret-2" });
        const bundle = buildTaskBundleDir(REPO_ROOT, TASK_ID_1);

        const instruction = readFileSync(
          path.join(REPO_ROOT, "tasks", "regex-log", "instruction.md"),
          "utf8",
        );
        const tasks = [
          {
            id: TASK_ID_1,
            image: "alexgshaw/regex-log:20251031",
            instruction,
            agent_timeout_sec: 60,
            verifier_timeout_sec: 300,
          },
          {
            // Second task must never be attempted once task 1 alone
            // crosses the $2 cap -- its id/image are nominal, no
            // container should ever be created for it.
            id: TASK_ID_2,
            image: "alexgshaw/regex-log:20251031",
            instruction,
            agent_timeout_sec: 60,
            verifier_timeout_sec: 300,
          },
        ];

        const env = {
          ...process.env,
          RUN_ID: BUDGET_RUN_ID,
          CALLBACK_BASE: baseUrl,
          RUNNER_CALLBACK_SECRET: "test-secret-2",
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
          child.on("error", reject);
          child.on("close", (code) => resolve(code));
        });

        await stop();
        rmSync(tgzRoot, { recursive: true, force: true });
        bundle.cleanup();

        expect(exitCode).toBe(0);

        const startedTaskIds = state.events
          .filter((e) => e.type === "task.started")
          .map((e) => e.payload.task_id);
        expect(startedTaskIds).toEqual([TASK_ID_1]);

        const budgetEvent = state.events.find((e) => e.type === "run.budget_exceeded");
        expect(budgetEvent).toBeDefined();
        expect(budgetEvent.payload.tasks_completed).toBe(1);
        expect(budgetEvent.payload.spent_usd).toBeCloseTo(2.5, 6);
        expect(budgetEvent.payload.cap_usd).toBe(2);

        const finalStatus = state.statusUpdates.at(-1);
        expect(finalStatus.status).toBe("completed");
        expect(finalStatus.totals.over_budget).toBe(true);
        expect(finalStatus.task_results).toHaveLength(2);
        expect(finalStatus.task_results[0]).toMatchObject({
          task_id: TASK_ID_1,
          attempted: true,
        });
        expect(finalStatus.task_results[1]).toEqual({
          task_id: TASK_ID_2,
          attempted: false,
          passed: false,
        });

        // No container was ever created for the skipped second task.
        let secondContainerExists = true;
        try {
          execFileSync("docker", ["inspect", CONTAINER_NAMES[1]], { stdio: "ignore" });
        } catch {
          secondContainerExists = false;
        }
        expect(secondContainerExists).toBe(false);
      },
      600000,
    );
  },
);
