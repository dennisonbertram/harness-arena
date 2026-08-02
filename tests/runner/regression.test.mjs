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
//
// Regression coverage for issue #19 (runner hardening), added after the
// green implementation:
//  4. redactSecrets must survive a realistic noisy blob where the secret
//     value is a substring of other surrounding text (no under- or
//     over-redaction), and end-to-end through the real upload path when an
//     agent printenv's the gateway key into stdout/session.jsonl.
//  5. deliverTerminalStatus's fallback file must contain the *exact*
//     terminal payload (round-trips through JSON), not just a truthy write.
//  6. A task that throws mid-run must never leak its container (real
//     Docker, forced failure via RUNNER_FORCE_TASK_ERROR).
//  7. A missing session.jsonl (real Docker, no docker cp source) must floor
//     the task's cost rather than reporting $0.
//
// Regression coverage for the live-run 9f4a1b3e fixes, added after the
// green implementation in 6863ebb:
//  9. parseStdoutCost must prefer the message_end sum over the turn_end
//     cumulative fallback even when both appear in the same noisy stream
//     (realistic pi output has turn_end lines throughout, not just at the
//     very end) -- falling back to turn_end whenever it's merely present
//     would silently under/over-count real per-task cost.
//  10. When both session and stdout are unusable, cost is reported as
//      UNMEASURED (cost_usd absent, cost_source "unmeasured") -- never a
//      fabricated floor value.
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
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildContainerName,
  buildPiCommand,
  deliverTerminalStatus,
  parseSessionCost,
  parseStdoutCost,
  redactSecrets,
} from "../../scripts/runner/lib.mjs";
import { startCallbackServer } from "./fixtures/callback-server.mjs";
import { buildTaskBundleDir } from "./fixtures/task-bundle.mjs";

const RUNNER_IT = process.env.RUNNER_IT === "1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RUNNER_SCRIPT = path.join(REPO_ROOT, "scripts", "runner", "runner.mjs");
const TEST_GATEWAY_PROXY_PORT = "14599";
const LEGACY_REGEX_INSTRUCTION =
  "Write a deterministic regex result to /app/regex.txt for the synthetic runner fixture.";

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

describe("redactSecrets regression: realistic noisy blob with a substring-colliding secret", () => {
  it("redacts every occurrence of the secret and every vck_ token without touching surrounding words that merely contain similar substrings", () => {
    // "key" appears both as part of the secret value and as an unrelated
    // word elsewhere -- a naive implementation could over- or under-redact.
    const blob = [
      "[2026-01-01T00:00:00.000Z] starting task",
      "printenv: AI_GATEWAY_API_KEY=sk-abc-key-123",
      "note: this key rotation policy is unrelated to the value above",
      "leaked token vck_ABCdef012 embedded mid-sentence right here",
      "second occurrence: sk-abc-key-123 shows up again later",
      "[2026-01-01T00:00:05.000Z] task finished",
    ].join("\n");

    const result = redactSecrets(blob, ["sk-abc-key-123"]);

    expect(result).not.toContain("sk-abc-key-123");
    expect(result).not.toContain("vck_ABCdef012");
    expect(result).toContain("this key rotation policy is unrelated");
    expect(result).toContain("[2026-01-01T00:00:00.000Z] starting task");
    expect(result).toContain("[2026-01-01T00:00:05.000Z] task finished");
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(3);
  });
});

describe("parseStdoutCost regression: message_end sum takes priority over turn_end fallback in mixed noisy output", () => {
  it("sums only the message_end finals and ignores turn_end lines when both appear in the same stream", () => {
    const stdout = [
      JSON.stringify({ type: "turn_end", usage: { cost: { total: 0.05 } } }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", usage: { cost: { total: 0.004 } } },
      }),
      JSON.stringify({ type: "turn_end", usage: { cost: { total: 0.09 } } }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", usage: { cost: { total: 0.006 } } },
      }),
    ].join("\n");

    // If this fell back to the turn_end max (0.09) whenever turn_end lines
    // are merely present, it would badly over-report cost -- message_end
    // is the authoritative per-turn final whenever it exists at all.
    expect(parseStdoutCost(stdout)).toBeCloseTo(0.01, 10);
  });
});

describe("deliverTerminalStatus regression: fallback file content", () => {
  it("writes the exact terminal payload to the fallback path, not just a placeholder", async () => {
    const payload = {
      status: "completed",
      totals: { tasks_passed: 2, total_cost_usd: 1.7, over_budget: false },
      task_results: [
        { task_id: "a", attempted: true, passed: true, cost_usd: 1.2 },
        { task_id: "b", attempted: true, passed: false, cost_usd: 0.5 },
      ],
    };
    let written;
    const result = await deliverTerminalStatus({
      postFn: async () => false,
      payload,
      writeFallback: (_fallbackPath, content) => {
        written = JSON.parse(content);
      },
      fallbackPath: "/var/log/runner-terminal.json",
    });

    expect(result).toBe(false);
    expect(written).toEqual(payload);
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

        const instruction = LEGACY_REGEX_INSTRUCTION;
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
          GATEWAY_PROXY_PORT: TEST_GATEWAY_PROXY_PORT,
          GATEWAY_UPSTREAM: baseUrl,
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

// Builds a throwaway agentkit.tgz containing the given fixture script as
// /usr/local/bin/fake-pi.sh, mirroring the real agentkit.tgz -> /usr/local
// layout used by PI_INSTALL_MODE=agentkit.
function buildAgentkitTgz(fixtureName) {
  const tgzRoot = mkdtempSync(path.join(tmpdir(), "agentkit-fixture-"));
  mkdirSync(path.join(tgzRoot, "bin"), { recursive: true });
  const fakePiSrc = readFileSync(path.join(__dirname, "fixtures", fixtureName));
  const fakePiDest = path.join(tgzRoot, "bin", "fake-pi.sh");
  writeFileSync(fakePiDest, fakePiSrc);
  chmodSync(fakePiDest, 0o755);
  const agentkitTgz = path.join(tgzRoot, "agentkit.tgz");
  execFileSync("tar", ["-czf", agentkitTgz, "-C", tgzRoot, "bin"]);
  return { tgzRoot, agentkitTgz };
}

describe.skipIf(!RUNNER_IT)(
  "runner regression (RUNNER_IT=1, real local docker): container cleanup on mid-task error",
  () => {
    const TASK_IDS = ["regex-log-before-force-error", "regex-log-force-error"];
    const RUN_ID = "it-run-force-error";
    const CONTAINER_NAMES = TASK_IDS.map((taskId, index) =>
      buildContainerName(RUN_ID, index, taskId),
    );

    afterEach(() => {
      for (const containerName of CONTAINER_NAMES) {
        try {
          execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
        } catch {
          // fine
        }
      }
    });

    it(
      "preserves completed task results and removes the container when a later task throws",
      async () => {
        const { tgzRoot, agentkitTgz } = buildAgentkitTgz("fake-pi.sh");
        const { state, baseUrl, stop } = await startCallbackServer({ secret: "test-secret-force-error" });
        const bundle = buildTaskBundleDir(REPO_ROOT, TASK_IDS[0]);
        const instruction = LEGACY_REGEX_INSTRUCTION;
        const tasks = TASK_IDS.map((id) => ({
          id,
          image: "alexgshaw/regex-log:20251031",
          instruction,
          agent_timeout_sec: 60,
          verifier_timeout_sec: 300,
        }));

        const env = {
          ...process.env,
          RUN_ID,
          CALLBACK_BASE: baseUrl,
          GATEWAY_PROXY_PORT: TEST_GATEWAY_PROXY_PORT,
          GATEWAY_UPSTREAM: baseUrl,
          RUNNER_CALLBACK_SECRET: "test-secret-force-error",
          AI_GATEWAY_API_KEY: "test-gateway-key",
          SYSTEM_PROMPT_B64: Buffer.from("You are a helpful coding agent.", "utf8").toString("base64"),
          BUDGET_CAP_USD: "2",
          TASKS_JSON_B64: Buffer.from(JSON.stringify(tasks), "utf8").toString("base64"),
          RUNNER_TASKS_DIR: bundle.root,
          AGENTKIT_TGZ: agentkitTgz,
          PI_INVOKE_OVERRIDE: "/usr/local/bin/fake-pi.sh",
          // Test-only hook: forces runOneTask to throw right after the
          // container is created, before pi ever runs.
          RUNNER_FORCE_TASK_ERROR: TASK_IDS[1],
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

        // The run itself failed (the forced error propagates uncaught out
        // of runOneTask), and delivery to the fake callback server
        // succeeds, so the process exits 0 -- what matters here is that
        // the container never leaked.
        expect(exitCode).toBe(0);

        // The early "running" post (issue #23 finding B) must land even on
        // a run that ultimately fails mid-task.
        expect(state.statusUpdates[0]?.status).toBe("running");

        const finalStatus = state.statusUpdates.at(-1);
        expect(finalStatus.status).toBe("failed");
        expect(finalStatus.task_results).toHaveLength(1);
        expect(finalStatus.task_results[0]).toMatchObject({
          task_id: TASK_IDS[0],
          attempted: true,
          passed: false,
        });
        expect(finalStatus.totals).toMatchObject({
          tasks_passed: 0,
          over_budget: false,
        });

        for (const containerName of CONTAINER_NAMES) {
          let containerStillExists = true;
          try {
            execFileSync("docker", ["inspect", containerName], { stdio: "ignore" });
          } catch {
            containerStillExists = false;
          }
          expect(containerStillExists).toBe(false);
        }
      },
      600000,
    );
  },
);

describe.skipIf(!RUNNER_IT)(
  "runner regression (RUNNER_IT=1, real local docker): cost floor on unreadable session",
  () => {
    const TASK_ID = "regex-log-nosession";
    const RUN_ID = "it-run-nosession";
    const CONTAINER_NAME = buildContainerName(RUN_ID, 0, TASK_ID);

    afterEach(() => {
      try {
        execFileSync("docker", ["rm", "-f", CONTAINER_NAME], { stdio: "ignore" });
      } catch {
        // fine
      }
    });

    it(
      "reports cost as UNMEASURED (no fabricated floor, cost_usd absent) when no session.jsonl is written",
      async () => {
        const { tgzRoot, agentkitTgz } = buildAgentkitTgz("fake-pi-nosession.sh");
        const { state, baseUrl, stop } = await startCallbackServer({ secret: "test-secret-nosession" });
        const bundle = buildTaskBundleDir(REPO_ROOT, TASK_ID);
        const instruction = LEGACY_REGEX_INSTRUCTION;
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
          RUN_ID,
          CALLBACK_BASE: baseUrl,
          GATEWAY_PROXY_PORT: TEST_GATEWAY_PROXY_PORT,
          GATEWAY_UPSTREAM: baseUrl,
          RUNNER_CALLBACK_SECRET: "test-secret-nosession",
          AI_GATEWAY_API_KEY: "test-gateway-key",
          SYSTEM_PROMPT_B64: Buffer.from("You are a helpful coding agent.", "utf8").toString("base64"),
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

        const agentFinished = state.events.find((e) => e.type === "task.agent_finished");
        expect(agentFinished.payload.cost_source).toBe("unmeasured");
        // No fabricated number — cost_usd is absent, not a floor.
        expect(agentFinished.payload.cost_usd).toBeUndefined();

        const tamperEvent = state.events.find((e) => e.type === "task.cost_tamper_signal");
        expect(tamperEvent).toBeDefined();
        expect(tamperEvent.payload.reason).toBe("cost_unmeasured");

        const gatewayCorrelation = state.events.find((e) => e.type === "task.gateway_correlation");
        expect(gatewayCorrelation).toBeDefined();
        expect(gatewayCorrelation.payload).toMatchObject({
          task_id: TASK_ID,
          proxy_requests: expect.any(Array),
          pi_response_ids: expect.any(Array),
          pi_retry_events: expect.any(Array),
        });

        const finalStatus = state.statusUpdates.at(-1);
        // Unmeasured tasks contribute nothing to the total (no invented spend).
        expect(finalStatus.totals.total_cost_usd).toBeCloseTo(0, 10);
      },
      600000,
    );
  },
);

describe.skipIf(!RUNNER_IT)(
  "runner regression (RUNNER_IT=1, real local docker): no fabricated cost floor",
  () => {
    const TASK_ID = "regex-log-default-floor";
    const RUN_ID = "it-run-default-floor";
    const CONTAINER_NAME = buildContainerName(RUN_ID, 0, TASK_ID);

    afterEach(() => {
      try {
        execFileSync("docker", ["rm", "-f", CONTAINER_NAME], { stdio: "ignore" });
      } catch {
        // fine
      }
    });

    it(
      "does NOT invent a cost floor — cost_usd is absent and cost_source is 'unmeasured' when no session and no stdout cost",
      async () => {
        const { tgzRoot, agentkitTgz } = buildAgentkitTgz("fake-pi-nosession.sh");
        const { state, baseUrl, stop } = await startCallbackServer({
          secret: "test-secret-default-floor",
        });
        const bundle = buildTaskBundleDir(REPO_ROOT, TASK_ID);
        const instruction = LEGACY_REGEX_INSTRUCTION;
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
          RUN_ID,
          CALLBACK_BASE: baseUrl,
          GATEWAY_PROXY_PORT: TEST_GATEWAY_PROXY_PORT,
          GATEWAY_UPSTREAM: baseUrl,
          RUNNER_CALLBACK_SECRET: "test-secret-default-floor",
          AI_GATEWAY_API_KEY: "test-gateway-key",
          SYSTEM_PROMPT_B64: Buffer.from("You are a helpful coding agent.", "utf8").toString("base64"),
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

        const agentFinished = state.events.find((e) => e.type === "task.agent_finished");
        expect(agentFinished.payload.cost_source).toBe("unmeasured");
        expect(agentFinished.payload.cost_usd).toBeUndefined();
      },
      600000,
    );
  },
);

describe.skipIf(!RUNNER_IT)(
  "runner regression (RUNNER_IT=1, real local docker): cost recovery from stdout on agent-timeout SIGTERM",
  () => {
    const TASK_IDS = ["regex-log-timeout-1", "regex-log-timeout-2"];
    const RUN_ID = "it-run-timeout";
    const CONTAINER_NAMES = TASK_IDS.map((taskId, index) =>
      buildContainerName(RUN_ID, index, taskId),
    );

    afterEach(() => {
      for (const containerName of CONTAINER_NAMES) {
        try {
          execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
        } catch {
          // fine
        }
      }
    });

    it(
      "records an agent timeout as a failed task, preserves its real stdout cost, and continues the benchmark",
      async () => {
        const { tgzRoot, agentkitTgz } = buildAgentkitTgz("fake-pi-timeout.sh");
        const { state, baseUrl, stop } = await startCallbackServer({ secret: "test-secret-timeout" });
        const bundle = buildTaskBundleDir(REPO_ROOT, TASK_IDS[0]);
        const instruction = LEGACY_REGEX_INSTRUCTION;
        const tasks = TASK_IDS.map((id) => ({
          id,
          image: "alexgshaw/regex-log:20251031",
          instruction,
          // Short enough that `timeout` SIGTERMs fake-pi-timeout.sh's
          // `sleep 120` well before it ever writes a session.jsonl.
          agent_timeout_sec: 3,
          verifier_timeout_sec: 300,
        }));

        const env = {
          ...process.env,
          RUN_ID,
          CALLBACK_BASE: baseUrl,
          GATEWAY_PROXY_PORT: TEST_GATEWAY_PROXY_PORT,
          GATEWAY_UPSTREAM: baseUrl,
          RUNNER_CALLBACK_SECRET: "test-secret-timeout",
          AI_GATEWAY_API_KEY: "test-gateway-key",
          SYSTEM_PROMPT_B64: Buffer.from("You are a helpful coding agent.", "utf8").toString("base64"),
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

        const agentFinished = state.events.filter((e) => e.type === "task.agent_finished");
        expect(agentFinished).toHaveLength(2);
        expect(agentFinished[0].payload.cost_source).toBe("stdout");
        // 0.006 + 0.009 from the two message_end events — a real recovered
        // cost, never a fabricated value.
        expect(agentFinished[0].payload.cost_usd).toBeCloseTo(0.015, 10);

        const finalStatus = state.statusUpdates.at(-1);
        expect(finalStatus.status).toBe("completed");
        expect(finalStatus.totals).toMatchObject({
          tasks_passed: 0,
          total_cost_usd: 0.03,
          over_budget: false,
        });
        expect(finalStatus.task_results).toHaveLength(2);
        expect(finalStatus.task_results).toEqual(
          TASK_IDS.map((taskId) =>
            expect.objectContaining({
              task_id: taskId,
              attempted: true,
              passed: false,
              failure_stage: "agent_timeout",
              cost_usd: 0.015,
            }),
          ),
        );
        expect(
          state.events
            .filter((event) => event.type === "task.failed")
            .map((event) => event.payload.task_id),
        ).toEqual(TASK_IDS);
        expect(state.events.some((event) => event.type === "run.failed")).toBe(false);
      },
      600000,
    );
  },
);

describe.skipIf(!RUNNER_IT)(
  "runner regression (RUNNER_IT=1, real local docker): full trace stored gzipped, never truncated",
  () => {
    const TASK_ID = "regex-log-bigstdout";
    const RUN_ID = "it-run-bigstdout";
    const CONTAINER_NAME = buildContainerName(RUN_ID, 0, TASK_ID);

    afterEach(() => {
      try {
        execFileSync("docker", ["rm", "-f", CONTAINER_NAME], { stdio: "ignore" });
      } catch {
        // fine
      }
    });

    it(
      "uploads the FULL ~600KB pi-stdout.txt gzip-compressed (no truncation)",
      async () => {
        const { tgzRoot, agentkitTgz } = buildAgentkitTgz("fake-pi-bigstdout.sh");
        const { state, baseUrl, stop } = await startCallbackServer({ secret: "test-secret-bigstdout" });
        const bundle = buildTaskBundleDir(REPO_ROOT, TASK_ID);
        const instruction = LEGACY_REGEX_INSTRUCTION;
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
          RUN_ID,
          CALLBACK_BASE: baseUrl,
          GATEWAY_PROXY_PORT: TEST_GATEWAY_PROXY_PORT,
          GATEWAY_UPSTREAM: baseUrl,
          RUNNER_CALLBACK_SECRET: "test-secret-bigstdout",
          AI_GATEWAY_API_KEY: "test-gateway-key",
          SYSTEM_PROMPT_B64: Buffer.from("You are a helpful coding agent.", "utf8").toString("base64"),
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

        const stdoutTrace = state.traces.find((t) => t.name === "pi-stdout.txt");
        expect(stdoutTrace).toBeDefined();
        // Stored gzip-compressed; the FULL ~600KB stdout must gunzip back with
        // no truncation (well over the old 262144 cap).
        const full = gunzipSync(stdoutTrace.body);
        expect(full.length).toBeGreaterThan(262144);

        // Cost must still be parsed from the FULL local stdout (the real
        // session.jsonl cost, 0.004).
        const agentFinished = state.events.find((e) => e.type === "task.agent_finished");
        expect(agentFinished.payload.cost_source).toBe("session");
        expect(agentFinished.payload.cost_usd).toBeCloseTo(0.004, 10);
      },
      600000,
    );
  },
);

describe.skipIf(!RUNNER_IT)(
  "runner regression (RUNNER_IT=1, real local docker): end-to-end secret redaction",
  () => {
    const TASK_ID = "regex-log-leaky";
    const RUN_ID = "it-run-leaky";
    const CONTAINER_NAME = buildContainerName(RUN_ID, 0, TASK_ID);
    const SECRET = "sk-real-gateway-secret-value";

    afterEach(() => {
      try {
        execFileSync("docker", ["rm", "-f", CONTAINER_NAME], { stdio: "ignore" });
      } catch {
        // fine
      }
    });

    it(
      "scrubs AI_GATEWAY_API_KEY and vck_ tokens from uploaded session.jsonl / pi-stdout.txt (issue #19 finding 1)",
      async () => {
        const { tgzRoot, agentkitTgz } = buildAgentkitTgz("fake-pi-leaky.sh");
        const { state, baseUrl, stop } = await startCallbackServer({ secret: "test-secret-leaky" });
        const bundle = buildTaskBundleDir(REPO_ROOT, TASK_ID);
        const instruction = LEGACY_REGEX_INSTRUCTION;
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
          RUN_ID,
          CALLBACK_BASE: baseUrl,
          GATEWAY_PROXY_PORT: TEST_GATEWAY_PROXY_PORT,
          GATEWAY_UPSTREAM: baseUrl,
          RUNNER_CALLBACK_SECRET: "test-secret-leaky",
          AI_GATEWAY_API_KEY: SECRET,
          SYSTEM_PROMPT_B64: Buffer.from("You are a helpful coding agent.", "utf8").toString("base64"),
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

        const sessionTrace = state.traces.find((t) => t.name === "session.jsonl");
        const stdoutTrace = state.traces.find((t) => t.name === "pi-stdout.txt");
        expect(sessionTrace).toBeDefined();
        expect(stdoutTrace).toBeDefined();

        const sessionBody = gunzipSync(sessionTrace.body).toString("utf8");
        const stdoutBody = gunzipSync(stdoutTrace.body).toString("utf8");

        expect(sessionBody).not.toContain(SECRET);
        expect(sessionBody).not.toContain("vck_leakedtoken999");
        expect(sessionBody).toContain("[REDACTED]");

        expect(stdoutBody).not.toContain(SECRET);
        expect(stdoutBody).not.toContain("vck_leakedtoken999");
        expect(stdoutBody).toContain("[REDACTED]");
      },
      600000,
    );
  },
);
