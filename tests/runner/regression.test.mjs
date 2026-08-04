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
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  REQUIRED_TASK_CONTAINER_SETUP_OPERATIONS,
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
const FIXTURE_MANIFEST_DIGEST = `sha256:${"b".repeat(64)}`;
const FIXTURE_CONFIG_DIGEST = `sha256:${"c".repeat(64)}`;

function taskImageLock(tasks) {
  return {
    version: 1,
    images: tasks.map((task) => ({
      task_id: task.id,
      lookup_ref: task.image,
      manifest_digest: FIXTURE_MANIFEST_DIGEST,
      config_digest: FIXTURE_CONFIG_DIGEST,
    })),
  };
}

function taskImageLockB64(tasks) {
  return Buffer.from(JSON.stringify(taskImageLock(tasks)), "utf8").toString("base64");
}

function fakeDockerIdentityLine(tasks) {
  const [entry] = taskImageLock(tasks).images;
  if (!entry || tasks.length !== 1) throw new Error("fake Docker identity requires exactly one locked task");
  const repository = entry.lookup_ref.slice(0, entry.lookup_ref.lastIndexOf(":"));
  const identity = JSON.stringify({
    Id: entry.config_digest,
    RepoDigests: [`${repository}@${entry.manifest_digest}`],
  });
  return `if [ "$1" = image ]; then printf '%s' '${identity}'; exit 0; fi`;
}

function availableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(String(address.port));
      });
    });
  });
}

function runRunnerWithDiagnostics(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER_SCRIPT], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-64 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function runnerFailureContext(result, state) {
  return JSON.stringify({
    exit_code: result.exitCode,
    event_types: state.events.map((event) => event.type),
    status_updates: state.statusUpdates.map((update) => update.status),
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

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

describe("runner regression: task-container setup failures", () => {
  const PRE_PI_SETUP_OPERATIONS = new Set([
    "container_create",
    "models_directory",
    "models_config_copy",
    "settings_config_copy",
    "agentkit_copy",
    "agentkit_extract",
    "system_prompt_copy",
  ]);

  it("does not reuse fixed gateway proxy ports under full-suite parallelism", () => {
    const source = readFileSync(new URL(import.meta.url), "utf8");
    expect(source).not.toMatch(/GATEWAY_PROXY_PORT:\s*"1460[45]"/);
  });

  it.each(REQUIRED_TASK_CONTAINER_SETUP_OPERATIONS)("fails closed for required setup operation %s", async (operation) => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "runner-setup-failure-"));
    const dockerLog = path.join(fixtureRoot, "docker.log");
    const fakeDocker = path.join(fixtureRoot, "fake-docker.sh");
    const tasks = [{
      id: "setup-failure",
      image: "example.invalid/task:latest",
      instruction: "This must not reach Pi.",
      agent_timeout_sec: 1,
      verifier_timeout_sec: 1,
    }];
    writeFileSync(
      fakeDocker,
      [
        "#!/usr/bin/env sh",
        "printf '%s\\n' \"$*\" >> \"$DOCKER_LOG\"",
        "if [ \"$1\" = info ]; then exit 0; fi",
        fakeDockerIdentityLine(tasks),
        "case \"$*\" in",
        "  run\\ *) operation=container_create ;;",
        "  *'mkdir -p /root/.pi/agent'*) operation=models_directory ;;",
        "  *':/root/.pi/agent/models.json'*) operation=models_config_copy ;;",
        "  *':/root/.pi/agent/settings.json'*) operation=settings_config_copy ;;",
        "  *':/tmp/agentkit.tgz'*) operation=agentkit_copy ;;",
        "  *'tar -xzf /tmp/agentkit.tgz -C /usr/local'*) operation=agentkit_extract ;;",
        "  *':/tmp/system-prompt.txt'*) operation=system_prompt_copy ;;",
        "  *'rm -rf /tests'*) operation=verifier_tests_remove ;;",
        "  *':/tests'*) operation=verifier_tests_copy ;;",
        "  *'mkdir -p /logs/verifier'*) operation=verifier_logs_directory ;;",
        "esac",
        "if [ \"$operation\" = \"$FAIL_SETUP_OPERATION\" ]; then",
        "  printf '%s\\n' 'setup failed: vck_setup_secret_123' >&2",
        "  exit 43",
        "fi",
        "exit 0",
      ].join("\n"),
      "utf8",
    );
    chmodSync(fakeDocker, 0o755);

    const { state, baseUrl, stop } = await startCallbackServer({ secret: "setup-secret" });
    const env = {
      ...process.env,
      RUN_ID: `setup-failure-${operation}`,
      CALLBACK_BASE: baseUrl,
      RUNNER_CALLBACK_SECRET: "setup-secret",
      AI_GATEWAY_API_KEY: "vck_setup_secret_123",
      GATEWAY_UPSTREAM: baseUrl,
      GATEWAY_PROXY_PORT: await availableLoopbackPort(),
      RUNNER_MODEL: "zai/glm-5.2-fast",
      TASKS_JSON_B64: Buffer.from(JSON.stringify(tasks), "utf8").toString("base64"),
      TASK_IMAGE_LOCK_B64: taskImageLockB64(tasks),
      SYSTEM_PROMPT_B64: Buffer.from("Use the fixture.", "utf8").toString("base64"),
      DOCKER_CMD: fakeDocker,
      DOCKER_LOG: dockerLog,
      FAIL_SETUP_OPERATION: operation,
    };

    const result = await runRunnerWithDiagnostics(env);
    await stop();

    try {
      const diagnostic = runnerFailureContext(result, state);
      expect(result.exitCode, diagnostic).toBe(0);
      const failure = state.events.find((event) => event.type === "task.failed");
      expect(failure?.payload, diagnostic).toMatchObject({
        task_id: "setup-failure",
        stage: "task_setup_error",
      });
      expect(failure?.payload.error).toContain(`"operation":"${operation}"`);
      expect(failure?.payload.error).toContain('"code":43');
      expect(failure?.payload.error).toContain("[REDACTED]");
      expect(failure?.payload.error).not.toContain("vck_setup_secret_123");
      const dockerCommands = readFileSync(dockerLog, "utf8");
      if (PRE_PI_SETUP_OPERATIONS.has(operation)) {
        expect(dockerCommands).not.toContain("-e AI_GATEWAY_API_KEY");
      } else {
        expect(dockerCommands).toContain("-e AI_GATEWAY_API_KEY");
      }
      expect(dockerCommands).not.toContain("bash /tests/test.sh");
      expect(state.events.map((event) => event.type)).not.toContain("task.verify_started");
      const runnerTrace = state.traces.find((trace) => trace.name === "runner-log.txt");
      const runnerLog = gunzipSync(runnerTrace.body).toString("utf8");
      expect(runnerLog).toContain(`"operation":"${operation}"`);
      expect(runnerLog).toContain("[REDACTED]");
      expect(runnerLog).not.toContain("vck_setup_secret_123");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps the canonical operation registry aligned with setup call sites", () => {
    const runnerSource = readFileSync(RUNNER_SCRIPT, "utf8");
    const taskRunner = runnerSource.slice(runnerSource.indexOf("async function runOneTask"));
    const operations = [...taskRunner.matchAll(/setup\s*\(\s*"([a-z_]+)"/g)].map((match) => match[1]);
    // Do not deduplicate: duplicate labels must fail the alignment check.
    expect(operations.sort()).toEqual([...REQUIRED_TASK_CONTAINER_SETUP_OPERATIONS].sort());
    // Whitespace-tolerant guard catches the current multiline verifier call,
    // which the old same-line regex silently missed.
    expect(taskRunner).not.toMatch(/\bsh\s*\(\s*DOCKER_CMD\s*,/);
    // Exactly two runner-local Docker call sites are permitted: setup's
    // fail-closed wrapper and the verifier execution. A direct runDocker call
    // added elsewhere would bypass setup and fail this count/shape guard.
    expect(taskRunner.match(/\brunDocker\s*\(/g)).toHaveLength(2);
    expect(taskRunner).toMatch(/const result = runDocker\s*\(\s*args\s*\)/);
    expect(taskRunner).toMatch(/const verifyResult = runDocker\s*\(\s*\[\s*"exec"\s*,\s*"-w"/);
  });

  it("keeps completed Pi cost and agent traces when verifier setup fails", async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "runner-verifier-setup-cost-"));
    const fakeDocker = path.join(fixtureRoot, "fake-docker.sh");
    const tasks = [{
      id: "verifier-setup-cost",
      image: "example.invalid/task:latest",
      instruction: "Produce evidence before verifier setup.",
      agent_timeout_sec: 1,
      verifier_timeout_sec: 1,
    }];
    writeFileSync(
      fakeDocker,
      [
        "#!/usr/bin/env sh",
        "if [ \"$1\" = info ]; then exit 0; fi",
        fakeDockerIdentityLine(tasks),
        "case \"$*\" in",
        "  *'-e AI_GATEWAY_API_KEY'*)",
        "    printf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"usage\":{\"cost\":{\"total\":0.25}}}}'",
        "    exit 0 ;;",
        "  *'rm -rf /tests'*) printf '%s\\n' 'tests cleanup failed' >&2; exit 43 ;;",
        "esac",
        "exit 0",
      ].join("\n"),
      "utf8",
    );
    chmodSync(fakeDocker, 0o755);
    const { state, baseUrl, stop } = await startCallbackServer({ secret: "verifier-setup-secret" });
    const env = {
      ...process.env,
      RUN_ID: "verifier-setup-cost",
      CALLBACK_BASE: baseUrl,
      RUNNER_CALLBACK_SECRET: "verifier-setup-secret",
      AI_GATEWAY_API_KEY: "test-key",
      GATEWAY_UPSTREAM: baseUrl,
      GATEWAY_PROXY_PORT: await availableLoopbackPort(),
      TASKS_JSON_B64: Buffer.from(JSON.stringify(tasks), "utf8").toString("base64"),
      TASK_IMAGE_LOCK_B64: taskImageLockB64(tasks),
      SYSTEM_PROMPT_B64: Buffer.from("", "utf8").toString("base64"),
      DOCKER_CMD: fakeDocker,
      PI_INSTALL_MODE: "none",
    };
    const result = await runRunnerWithDiagnostics(env);
    await stop();

    try {
      const diagnostic = runnerFailureContext(result, state);
      expect(result.exitCode, diagnostic).toBe(0);
      const failure = state.events.find((event) => event.type === "task.failed");
      expect(failure?.payload, diagnostic).toMatchObject({ task_id: "verifier-setup-cost", stage: "task_setup_error" });
      expect(state.events.map((event) => event.type)).toContain("task.agent_finished");
      expect(state.events.map((event) => event.type)).not.toContain("task.verify_started");
      const stdoutTrace = state.traces.find((trace) => trace.name === "pi-stdout.txt");
      expect(gunzipSync(stdoutTrace.body).toString("utf8")).toContain('"total":0.25');
      const terminal = state.statusUpdates.at(-1);
      expect(terminal.totals.total_cost_usd).toBeCloseTo(0.25, 10);
      expect(terminal.task_results[0]).toMatchObject({
        task_id: "verifier-setup-cost",
        cost_usd: 0.25,
        cost_source: "stdout",
        failure_stage: "task_setup_error",
      });
      expect(terminal.task_results[0].trace_blob_url).toBe("fake://blob/verifier-setup-cost/session.jsonl");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
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
