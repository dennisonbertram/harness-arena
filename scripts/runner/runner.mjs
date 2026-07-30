#!/usr/bin/env node
// Zero-dependency task-run driver (issue #6). Runs INSIDE the sandbox: for
// every task in TASKS_JSON_B64, starts a fresh container from the task
// image, injects the agent kit, invokes `pi` with the submitted system
// prompt, verifies the result, uploads traces, and reports events/results
// to CALLBACK_BASE per callback-contract.md / event-taxonomy.md.
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  openSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  budgetExceeded,
  buildPiSettings,
  buildContainerName,
  buildPiCommand,
  buildPinnedModelsConfig,
  PI_MODELS_CONFIG_PATH,
  PI_SETTINGS_CONFIG_PATH,
  preflightProxy,
  resolvePinnedProvider,
  computeTotals,
  deliverTerminalStatus,
  fetchWithTimeout,
  flushWithPendingStatus,
  isSessionTextUnreadable,
  parseSessionAgentError,
  parseReward,
  parseSessionCost,
  parseStdoutCost,
  redactSecrets,
  resolveTaskCost,
  safeCleanup,
  sh,
  shAsync,
} from "./lib.mjs";

const DOCKER_CMD = process.env.DOCKER_CMD || "docker";
const PI_INSTALL_MODE = process.env.PI_INSTALL_MODE || "agentkit";
const AGENTKIT_TGZ = process.env.AGENTKIT_TGZ || "/opt/agentkit.tgz";
const PI_INVOKE_OVERRIDE = process.env.PI_INVOKE_OVERRIDE || undefined;
const RUNNER_TASKS_DIR = process.env.RUNNER_TASKS_DIR || "/opt/runner/tasks";
// Model routing. Default = Vercel AI Gateway. Set RUNNER_PROVIDER=openrouter and
// RUNNER_MODEL=z-ai/glm-5.2 (plus OPENROUTER_API_KEY in the env) to match
// harnessarena.xyz's exact provider. Both provider API keys are forwarded into
// the task container; pi uses the one matching --provider.
const RUNNER_PROVIDER = process.env.RUNNER_PROVIDER || "vercel-ai-gateway";
// Which upstream the gateway is pinned to for this run. Empty = unpinned, and
// the run is recorded without provider_pinned so the board can mark it as not
// comparable. See scripts/runner/gateway-proxy.mjs.
const PINNED_PROVIDER = process.env.PINNED_PROVIDER || "";
const GATEWAY_PROXY_PORT = Number(process.env.GATEWAY_PROXY_PORT || 4599);
const RUNNER_MODEL = process.env.RUNNER_MODEL || "zai/glm-5.2";
// Pi defaults reasoning models to medium. The dedicated fast-tier GLM route is
// for low-latency competition runs, so do not spend the whole task window on
// hidden reasoning before the first tool call. An explicit env value still
// wins for controlled experiments.
const RUNNER_THINKING =
  process.env.RUNNER_THINKING || (RUNNER_MODEL === "zai/glm-5.2-fast" ? "off" : undefined);
// Safety ceiling only, NOT the metric: raised 2->10 so a fuller (costlier)
// solution can complete the whole test instead of being killed mid-run, which
// would deflate its pass rate. Sandbox.ts passes the real value; this default
// is the fallback.
const BUDGET_CAP_USD = parseFloat(process.env.BUDGET_CAP_USD ?? "10");
// Upper bound on the pi stdout we hold in memory (cost parsing + trace). Traces
// are gzip-uploaded in full, so this is only a memory-safety ceiling for a
// runaway-verbose process, not a routine trace cut -- a real per-task stdout is
// well under this. gzip keeps even this bound's worth of text far below the
// callback body limit.
const STDOUT_CAP_BYTES = parseInt(process.env.RUNNER_STDOUT_CAP_BYTES ?? String(16 * 1024 * 1024), 10);
const HTTP_TIMEOUT_MS = parseInt(process.env.RUNNER_HTTP_TIMEOUT_MS ?? "20000", 10);
const DOCKER_INFO_TIMEOUT_MS = parseInt(process.env.RUNNER_DOCKER_INFO_TIMEOUT_MS ?? "10000", 10);
const TERMINAL_FALLBACK_PATH =
  process.env.RUNNER_TERMINAL_FALLBACK_PATH || "/var/log/runner-terminal.json";
// Test-only hook: throws inside runOneTask for the named task id, to prove
// container cleanup happens even when a task errors mid-run (issue #19
// finding 5). Never set in production.
const RUNNER_FORCE_TASK_ERROR = process.env.RUNNER_FORCE_TASK_ERROR || undefined;

const RUN_ID = process.env.RUN_ID;
const CALLBACK_BASE = process.env.CALLBACK_BASE;
const RUNNER_CALLBACK_SECRET = process.env.RUNNER_CALLBACK_SECRET;

const SESSION_DIR = "/logs/agent/sessions";
const PROMPT_FILE = "/tmp/system-prompt.txt";
const DOCKERD_LOG = "/var/log/dockerd.log";

if (!RUN_ID || !CALLBACK_BASE || !RUNNER_CALLBACK_SECRET) {
  console.error("runner: RUN_ID, CALLBACK_BASE, RUNNER_CALLBACK_SECRET are required env vars");
  process.exit(1);
}

const runnerLogLines = [];
function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  runnerLogLines.push(stamped);
  console.log(stamped);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeB64(value) {
  return Buffer.from(value, "base64").toString("utf8");
}

function capAt(buffer, maxBytes) {
  return buffer.length > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
}

function tailFile(filePath, maxBytes) {
  try {
    const buf = readFileSync(filePath);
    return buf.subarray(Math.max(0, buf.length - maxBytes)).toString("utf8");
  } catch {
    return `(no log file at ${filePath})`;
  }
}

// --- docker readiness ------------------------------------------------------
function dockerInfoReady() {
  // Bounded per-attempt deadline: a wedged dockerd must never block this
  // poll loop past DOCKER_INFO_TIMEOUT_MS on a single attempt.
  return sh(DOCKER_CMD, ["info"], { timeout: DOCKER_INFO_TIMEOUT_MS }).code === 0;
}

async function pollDockerReady(waitSec) {
  const deadline = Date.now() + waitSec * 1000;
  while (Date.now() < deadline) {
    if (dockerInfoReady()) return true;
    await sleep(2000);
  }
  return false;
}

function startDockerdBackground() {
  let logFd;
  try {
    logFd = openSync(DOCKERD_LOG, "a");
  } catch {
    logFd = "ignore";
  }
  const child = spawn("dockerd", [], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
}

async function ensureDockerReady() {
  if (dockerInfoReady()) return true;

  log("docker info failed; removing stale pid/sock and starting dockerd");
  for (const waitSec of [60, 30]) {
    rmSync("/var/run/docker.pid", { force: true });
    rmSync("/var/run/docker.sock", { force: true });
    startDockerdBackground();
    if (await pollDockerReady(waitSec)) return true;
    log(`dockerd not ready after ${waitSec}s`);
  }
  return false;
}

// --- callback client (retry 3x with backoff; never crash the run) --------
let pendingEvents = [];
// Stashed status/totals/task_results payload (e.g. {status:"running"})
// from the most recent flushEvents call whose POST hasn't yet succeeded.
// Retried on every subsequent flush via flushWithPendingStatus until
// delivery succeeds (issue evidence: run 9f4a1b3e stayed status=queued
// its entire duration because a lost "running" post was never resent).
let pendingStatus = null;

function queueEvent(type, payload) {
  pendingEvents.push({ ts: new Date().toISOString(), type, payload });
}

async function postWithRetry(url, body, isJson) {
  const headers = { "x-runner-secret": RUNNER_CALLBACK_SECRET };
  headers["content-type"] = isJson ? "application/json" : "application/octet-stream";
  const payload = isJson ? JSON.stringify(body) : body;
  const delays = [0, 500, 1500];
  let lastErr;
  for (const delay of delays) {
    if (delay) await sleep(delay);
    try {
      const res = await fetchWithTimeout(
        fetch,
        url,
        { method: "POST", headers, body: payload },
        HTTP_TIMEOUT_MS,
      );
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  log(`callback POST failed after retries (${url}): ${lastErr?.message}`);
  return null;
}

// Flush queued events (optionally with a status/totals/task_results update
// in the same POST). On failure, events are kept queued for the next
// flush -- one failed post never crashes the run.
async function flushEvents(extra = {}) {
  const events = pendingEvents;
  pendingEvents = [];
  const { result, pendingStatus: nextStatus } = await flushWithPendingStatus({
    postFn: (body) => postWithRetry(`${CALLBACK_BASE}/api/runs/${RUN_ID}/callback`, body, true),
    events,
    pendingStatus,
    extra,
  });
  if (result === null) {
    pendingEvents = events.concat(pendingEvents);
  }
  pendingStatus = nextStatus;
  return result;
}

// Fetch grading materials (tests/*) from the authenticated /api/runner-tests
// route and write them under RUNNER_TASKS_DIR/<id>/tests, where runOneTask's
// verify step docker-cp's them into each task container AFTER the agent's turn.
// These are NOT in the public runner bundle (that would let any harness read
// the assertions it's graded against); only this runner, which holds
// RUNNER_CALLBACK_SECRET, can fetch them. Fails closed: a run cannot be scored
// without tests, so a fetch failure aborts the run rather than silently passing.
async function fetchTaskTests() {
  const url = `${CALLBACK_BASE}/api/runner-tests`;
  const delays = [0, 500, 1500];
  let lastErr;
  for (const delay of delays) {
    if (delay) await sleep(delay);
    try {
      const res = await fetchWithTimeout(
        fetch,
        url,
        { method: "GET", headers: { "x-runner-secret": RUNNER_CALLBACK_SECRET } },
        HTTP_TIMEOUT_MS,
      );
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      const { tests } = await res.json();
      let fileCount = 0;
      for (const [taskId, files] of Object.entries(tests ?? {})) {
        for (const [rel, b64] of Object.entries(files)) {
          const dst = path.join(RUNNER_TASKS_DIR, taskId, "tests", rel);
          mkdirSync(path.dirname(dst), { recursive: true });
          writeFileSync(dst, Buffer.from(b64, "base64"));
          fileCount += 1;
        }
      }
      log(`fetched tests for ${Object.keys(tests ?? {}).length} task(s), ${fileCount} file(s)`);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`fetch task tests failed after retries: ${lastErr?.message ?? lastErr}`);
}

// Traces are uploaded gzip-compressed so the FULL, untruncated trace fits
// under the callback's request-body limit (a JSONL/text trace compresses
// ~10x). The server stores the bytes as-is; the trace-view route decompresses
// on read. We never truncate — cutting data out of a trace is not allowed.
async function uploadTrace(taskId, name, buffer) {
  const url = `${CALLBACK_BASE}/api/runs/${RUN_ID}/trace?task_id=${encodeURIComponent(taskId)}&name=${encodeURIComponent(name)}`;
  const gz = gzipSync(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  return postWithRetry(url, gz, false);
}

// Upload the agent-side evidence on every terminal task path, including an
// agent timeout that never reaches verification. Previously timeout traces
// disappeared with the thrown error, leaving only a run-level message and no
// way to distinguish a provider stall from an agent that produced bad work.
async function uploadAgentTraces(taskId, sessionText, piStdout) {
  const secrets = [process.env.AI_GATEWAY_API_KEY].filter(Boolean);
  let traceBlobUrl;
  const redactedSession = redactSecrets(sessionText, secrets);
  const sessionUpload = await uploadTrace(
    taskId,
    "session.jsonl",
    Buffer.from(redactedSession, "utf8"),
  );
  if (sessionUpload?.url) {
    traceBlobUrl = sessionUpload.url;
    queueEvent("task.trace_uploaded", { task_id: taskId, blob_url: sessionUpload.url });
  }
  const redactedStdout = Buffer.from(
    redactSecrets(piStdout.toString("utf8"), secrets),
    "utf8",
  );
  const stdoutUpload = await uploadTrace(taskId, "pi-stdout.txt", redactedStdout);
  if (stdoutUpload?.url) {
    queueEvent("task.trace_uploaded", { task_id: taskId, blob_url: stdoutUpload.url });
  }
  return { traceBlobUrl, secrets };
}

// Terminal status delivery (status completed/failed + totals) is the one
// callback that must never be silently lost: flushEvents already retries
// the POST 3x with backoff; if it still fails, write the payload to
// TERMINAL_FALLBACK_PATH for a reaper/reconciliation process and signal
// non-delivery so main() exits non-zero instead of exiting 0 on a lost
// final status. Non-terminal event-post failures stay non-fatal (queued
// via flushEvents/pendingEvents as before).
async function finalizeTerminalStatus(payload) {
  return deliverTerminalStatus({
    postFn: async (p) => (await flushEvents(p)) !== null,
    payload,
    writeFallback: (fallbackPath, json) => {
      try {
        writeFileSync(fallbackPath, json);
      } catch (writeErr) {
        log(`failed to write terminal fallback file ${fallbackPath}: ${writeErr?.message ?? writeErr}`);
      }
    },
    fallbackPath: TERMINAL_FALLBACK_PATH,
  });
}

// --- per-task docker helpers -----------------------------------------------
function cleanupContainer(containerName) {
  sh(DOCKER_CMD, ["rm", "-f", containerName]);
}

function writeTempFile(content) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "runner-"));
  const file = path.join(dir, "content");
  writeFileSync(file, content, "utf8");
  return file;
}

function walkFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function extractNewestSessionJsonl(containerName) {
  const hostDir = path.join(os.tmpdir(), `runner-sess-${containerName}-${Date.now()}`);
  const cp = sh(DOCKER_CMD, ["cp", `${containerName}:${SESSION_DIR}`, hostDir]);
  if (cp.code !== 0) return "";
  const jsonlFiles = walkFiles(hostDir).filter((f) => f.endsWith(".jsonl"));
  if (jsonlFiles.length === 0) return "";
  jsonlFiles.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  try {
    return readFileSync(jsonlFiles[0], "utf8");
  } finally {
    rmSync(hostDir, { recursive: true, force: true });
  }
}

function readRewardFile(containerName) {
  const hostFile = path.join(os.tmpdir(), `runner-reward-${containerName}-${Date.now()}.txt`);
  const cp = sh(DOCKER_CMD, ["cp", `${containerName}:/logs/verifier/reward.txt`, hostFile]);
  if (cp.code !== 0) return null;
  try {
    return readFileSync(hostFile, "utf8");
  } catch {
    return null;
  } finally {
    rmSync(hostFile, { force: true });
  }
}

let gatewayProxy = null;

/**
 * Starts the pinning sidecar on the sandbox VM. pi runs inside the task
 * container and reaches this through the --add-host host-gateway mapping.
 * Only started when a provider is actually pinned, so an unpinned run behaves
 * exactly as before rather than gaining a new failure mode.
 */
// The prompt pi actually sent, captured off the wire by the sidecar. A
// baseline runs vanilla, so this is the only faithful record of what pi's
// default resolved to inside this container -- see systemPromptOf().
let resolvedSystemPrompt;
// Set only when the sidecar actually pinned a request -- see
// resolvePinnedProvider(). Configuration alone must never mark a run pinned.
let pinWasApplied = false;

async function startGatewayProxy() {
  const { createGatewayProxy } = await import("./gateway-proxy.mjs");
  const server = createGatewayProxy({
    only: PINNED_PROVIDER ? [PINNED_PROVIDER] : [],
    onForward: (event) => {
      if (!resolvedSystemPrompt && event.systemPrompt) resolvedSystemPrompt = event.systemPrompt;
      if (event.only?.length) pinWasApplied = true;
    },
  });
  await new Promise((resolve) => server.listen(GATEWAY_PROXY_PORT, "0.0.0.0", resolve));
  log(`gateway proxy listening on :${GATEWAY_PROXY_PORT}, pinned to ${PINNED_PROVIDER || "(nothing)"}`);
  return server;
}

async function runOneTask(task, index, systemPrompt) {
  const containerName = buildContainerName(RUN_ID, index, task.id);
  const taskStart = Date.now();
  const tempDirs = [];

  try {
    queueEvent("task.started", { task_id: task.id, index });
    await flushEvents();

    cleanupContainer(containerName);
    sh(DOCKER_CMD, [
      "run",
      "-d",
      // Lets pi inside the container reach the pinning sidecar running on the
      // sandbox VM. Harmless when nothing is pinned.
      "--add-host",
      "host.docker.internal:host-gateway",
      "--name",
      containerName,
      task.image,
      "sh",
      "-c",
      `sleep ${task.agent_timeout_sec + 900}`,
    ]);

    {
      // pi cannot add the gateway's providerOptions itself, but it can take a
      // baseUrl -- so point its gateway provider at the sidecar, which injects
      // the pin (when there is one) and forwards. Unpinned runs go through it
      // too: it is what captures the resolved system prompt, and routing only
      // some runs through a proxy would itself be a difference between them
      // beyond the pin under test.
      const cfg = buildPinnedModelsConfig({ proxyPort: GATEWAY_PROXY_PORT, model: RUNNER_MODEL });
      const cfgFile = path.join(os.tmpdir(), `models-${RUN_ID}-${index}.json`);
      writeFileSync(cfgFile, cfg);
      tempDirs.push(cfgFile);
      // pi only reads this path (see PI_MODELS_CONFIG_PATH); mkdir -p because
      // the agent/ directory does not exist in a bare container.
      sh(DOCKER_CMD, ["exec", containerName, "mkdir", "-p", path.posix.dirname(PI_MODELS_CONFIG_PATH)]);
      sh(DOCKER_CMD, ["cp", cfgFile, `${containerName}:${PI_MODELS_CONFIG_PATH}`]);

      const settings = buildPiSettings({ model: RUNNER_MODEL });
      if (settings) {
        const settingsFile = path.join(os.tmpdir(), `settings-${RUN_ID}-${index}.json`);
        writeFileSync(settingsFile, settings);
        tempDirs.push(settingsFile);
        sh(DOCKER_CMD, ["cp", settingsFile, `${containerName}:${PI_SETTINGS_CONFIG_PATH}`]);
      }
    }

    if (PI_INSTALL_MODE === "agentkit") {
      sh(DOCKER_CMD, ["cp", AGENTKIT_TGZ, `${containerName}:/tmp/agentkit.tgz`]);
      sh(DOCKER_CMD, ["exec", containerName, "tar", "-xzf", "/tmp/agentkit.tgz", "-C", "/usr/local"]);
    }

    // NOTE: an earlier global 8192-token anti-runaway cap backfired badly for
    // non-fast glm-5.2: it starved real work and reduced the 16-task baseline
    // from ~10/16 to 2/16. The provider metadata therefore keeps that model's
    // native ceiling. GLM-5.2 Fast is different: production showed Fireworks
    // spending hidden reasoning despite thinking=off until the five-minute
    // task timeout. Its model definition carries a Fast-only 8192 ceiling,
    // which applies equally to baseline and competitors.
    // An empty submitted prompt means "run vanilla pi with its own default
    // system prompt" (the baseline), matching harnessarena.xyz. Only write and
    // pass a prompt file when there's actually a submitted prompt.
    const hasSystemPrompt = typeof systemPrompt === "string" && systemPrompt.trim().length > 0;
    if (hasSystemPrompt) {
      const promptHostFile = writeTempFile(systemPrompt);
      tempDirs.push(path.dirname(promptHostFile));
      sh(DOCKER_CMD, ["cp", promptHostFile, `${containerName}:${PROMPT_FILE}`]);
    }

    // Test-only: force an exception mid-task to prove the finally block
    // below still removes the container (issue #19 finding 5).
    if (RUNNER_FORCE_TASK_ERROR && RUNNER_FORCE_TASK_ERROR === task.id) {
      throw new Error(`RUNNER_FORCE_TASK_ERROR: forced failure for task ${task.id}`);
    }

    const piCommand = buildPiCommand({
      agentTimeoutSec: task.agent_timeout_sec,
      sessionDir: SESSION_DIR,
      promptFile: PROMPT_FILE,
      instruction: task.instruction,
      override: PI_INVOKE_OVERRIDE,
      hasSystemPrompt,
      provider: RUNNER_PROVIDER,
      model: RUNNER_MODEL,
      thinking: RUNNER_THINKING,
    });

    // `-e AI_GATEWAY_API_KEY` (no `=value`) makes docker exec pass the value
    // through from this process's own environment -- execFile inherits
    // process.env by default, so no extra plumbing is needed here. maxBuffer is
    // large (64MB): a verbose pi run streamed ~5.2MB and the old 5MB cap threw
    // (ENOBUFS), killing pi mid-task -- the "0-turn crash" tasks. This call
    // MUST be async: the gateway proxy runs in this same Node process and a
    // synchronous docker exec starves its event loop for the whole model turn.
    const execResult = await shAsync(
      DOCKER_CMD,
      [
        "exec",
        "-w",
        "/app",
        "-e",
        "AI_GATEWAY_API_KEY",
        "-e",
        "OPENROUTER_API_KEY",
        containerName,
        "sh",
        "-c",
        piCommand,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const piStdout = capAt(Buffer.concat([execResult.stdout, execResult.stderr]), STDOUT_CAP_BYTES);
    const agentFinishedAt = Date.now();

    const sessionText = extractNewestSessionJsonl(containerName);
    const sessionUnreadable = isSessionTextUnreadable(sessionText);
    const parsed = parseSessionCost(sessionText);
    const turns = parsed.turns;

    // Cost tamper resistance (issue #19 finding 2): a root agent can rewrite
    // its own session JSONL. A missing/empty/unparseable session file is
    // treated as unreadable; rather than immediately flooring it, the real
    // cost recovered from pi's captured stdout is used if available (live-run
    // evidence: run 9f4a1b3e -- an agent-timeout SIGTERM killed pi before it
    // flushed session.jsonl, but pi had already written real per-turn cost
    // data to stdout). Only when stdout has no usable cost either does this
    // fall back to the configurable floor. Negative cost.total values from
    // the session are clamped and counted as a tamper signal by
    // parseSessionCost. The platform's gateway-credits ledger remains the
    // authoritative spend ceiling -- this is a secondary, spoofable signal
    // surfaced for visibility.
    const stdoutCost = sessionUnreadable ? parseStdoutCost(piStdout.toString("utf8")) : 0;
    const { totalCost, costSource } = resolveTaskCost({
      sessionUnreadable,
      sessionCost: parsed.totalCost,
      stdoutCost,
    });

    if (sessionUnreadable) {
      log(`task ${task.id}: cost_source: ${costSource}`);
      if (costSource === "unmeasured") {
        // Neither session nor stdout carried a cost — reported as unmeasured
        // (no fabricated number). Surfaced as a signal for visibility.
        queueEvent("task.cost_tamper_signal", {
          task_id: task.id,
          reason: "cost_unmeasured",
          cost_source: costSource,
        });
      }
    } else if (parsed.negativeCostCount > 0) {
      log(
        `task ${task.id}: ${parsed.negativeCostCount} negative cost.total value(s) ignored (tamper signal)`,
      );
      queueEvent("task.cost_tamper_signal", {
        task_id: task.id,
        reason: "negative_cost_total",
        cost_source: costSource,
        negative_cost_count: parsed.negativeCostCount,
      });
    }

    queueEvent("task.agent_finished", {
      task_id: task.id,
      turns,
      ...(totalCost === null ? {} : { cost_usd: totalCost }),
      cost_source: costSource,
      duration_s: (agentFinishedAt - taskStart) / 1000,
    });
    await flushEvents();

    // GNU timeout exits 124 after the configured agent deadline. This is a
    // failed task, not a failed benchmark run: a weak or temporarily stalled
    // model must not discard earlier results or prevent the remaining selected
    // tasks from running. The hard kill still bounds each task; the runner now
    // records the timeout transparently and continues.
    if (execResult.code === 124 || execResult.code === 137) {
      const error = (
        `Agent timed out after ${task.agent_timeout_sec}s waiting for model output ` +
        `(provider=${PINNED_PROVIDER || "automatic"}, model=${RUNNER_MODEL})`
      );
      const { traceBlobUrl } = await uploadAgentTraces(task.id, sessionText, piStdout);
      queueEvent("task.failed", {
        task_id: task.id,
        stage: "agent_timeout",
        error,
        duration_s: (Date.now() - taskStart) / 1000,
      });
      await flushEvents();
      return {
        task_id: task.id,
        attempted: true,
        passed: false,
        reward: 0,
        cost_usd: totalCost === null ? undefined : totalCost,
        cost_source: costSource,
        duration_s: (Date.now() - taskStart) / 1000,
        turns,
        trace_blob_url: traceBlobUrl,
        failure_stage: "agent_timeout",
        error,
      };
    }

    // Pi exits 0 when its provider stream fails and records the real failure
    // only in the terminal assistant session record. Do not run the verifier
    // against an untouched workspace and mislabel that as a test failure.
    const agentError = parseSessionAgentError(sessionText);
    if (agentError) {
      const error =
        `${agentError.error} ` +
        `(provider=${PINNED_PROVIDER || "automatic"}, model=${RUNNER_MODEL})`;
      const { traceBlobUrl } = await uploadAgentTraces(task.id, sessionText, piStdout);
      queueEvent("task.failed", {
        task_id: task.id,
        stage: agentError.stage,
        error,
        duration_s: (Date.now() - taskStart) / 1000,
      });
      await flushEvents();
      return {
        task_id: task.id,
        attempted: true,
        passed: false,
        reward: 0,
        cost_usd: totalCost === null ? undefined : totalCost,
        cost_source: costSource,
        duration_s: (Date.now() - taskStart) / 1000,
        turns,
        trace_blob_url: traceBlobUrl,
        failure_stage: agentError.stage,
        error,
      };
    }

    // Verification against a clean copy of the task's tests.
    sh(DOCKER_CMD, ["exec", containerName, "rm", "-rf", "/tests"]);
    sh(DOCKER_CMD, ["cp", path.join(RUNNER_TASKS_DIR, task.id, "tests"), `${containerName}:/tests`]);
    sh(DOCKER_CMD, ["exec", containerName, "mkdir", "-p", "/logs/verifier"]);

    queueEvent("task.verify_started", { task_id: task.id });
    await flushEvents();

    const verifyStart = Date.now();
    const verifyResult = sh(
      DOCKER_CMD,
      ["exec", "-w", "/app", containerName, "sh", "-c", `timeout ${task.verifier_timeout_sec} bash /tests/test.sh`],
      { maxBuffer: 20 * 1024 * 1024 },
    );
    const verifyDurationS = (Date.now() - verifyStart) / 1000;

    const rewardText = readRewardFile(containerName);
    const passed = parseReward(rewardText);
    const rewardNumber = rewardText != null ? Number(String(rewardText).trim()) : NaN;
    const reward = Number.isFinite(rewardNumber) ? rewardNumber : 0;

    queueEvent("task.verified", { task_id: task.id, passed, reward, duration_s: verifyDurationS });
    await flushEvents();

    // Trace uploads -- secrets scrubbed from the bytes first (issue #19
    // finding 1): a root agent could printenv AI_GATEWAY_API_KEY into its
    // own session/stdout, and these traces are uploaded publicly. The FULL
    // trace is uploaded (gzip-compressed by uploadTrace so it fits under the
    // ~4.5MB callback body limit) -- no truncation.
    const { traceBlobUrl, secrets } = await uploadAgentTraces(task.id, sessionText, piStdout);
    // Verifier output -- the test.sh stdout/stderr + reward, so the run page's
    // Verifier tab shows WHY a task passed or failed, not just the reward.
    const verifierParts = [verifyResult.stdout?.toString("utf8") ?? ""];
    const verifyStderr = verifyResult.stderr?.toString("utf8") ?? "";
    if (verifyStderr.trim()) verifierParts.push(`\n[stderr]\n${verifyStderr}`);
    verifierParts.push(`\n[reward.txt] ${rewardText ?? "(missing)"}`);
    const verifierUpload = await uploadTrace(
      task.id,
      "verifier.txt",
      Buffer.from(redactSecrets(verifierParts.join(""), secrets), "utf8"),
    );
    if (verifierUpload?.url) {
      queueEvent("task.trace_uploaded", { task_id: task.id, blob_url: verifierUpload.url });
    }
    await flushEvents();

    return {
      task_id: task.id,
      attempted: true,
      passed,
      reward,
      // null (unmeasured) is carried as an absent cost_usd, never a fabricated
      // number; cost_source records why (unmeasured vs session/stdout).
      cost_usd: totalCost === null ? undefined : totalCost,
      cost_source: costSource,
      duration_s: (Date.now() - taskStart) / 1000,
      turns,
      trace_blob_url: traceBlobUrl,
    };
  } finally {
    // Runs on every path -- success, verification failure, or a thrown
    // exception mid-task -- so a task that errors never leaks its
    // container or temp files (issue #19 finding 5). Each cleanup step is
    // wrapped so a throw here (e.g. rmSync ENOENT/EACCES) can never mask
    // the real task error or turn a task's success into a crashed run
    // (issue #23 finding G2).
    safeCleanup(() => cleanupContainer(containerName), `container ${containerName}`, log);
    for (const dir of tempDirs) {
      safeCleanup(() => rmSync(dir, { recursive: true, force: true }), `temp dir ${dir}`, log);
    }
  }
}

// --- main -------------------------------------------------------------
async function main() {
  const startedAt = Date.now();
  const taskResults = [];
  let cumulativeCost = 0;
  let overBudget = false;
  try {
    // Must be listening before any task container starts, since pi's models.json
    // points at it. Started here rather than per-task so all 16 tasks in a run
    // share one pinned upstream.
    gatewayProxy = await startGatewayProxy();

    // Prove the path pi will use actually answers, before spending 16 tasks
    // finding out. When this broke, every task ran its full timeout and the run
    // reported 0 passes at 0 cost -- indistinguishable from a hopeless model.
    const preflight = await preflightProxy({
      port: GATEWAY_PROXY_PORT,
      model: RUNNER_MODEL,
      apiKey: process.env.AI_GATEWAY_API_KEY ?? "",
    });
    if (!preflight.ok) {
      log(`gateway preflight FAILED: ${preflight.detail}`);
      queueEvent("run.failed", {
        error: `gateway sidecar preflight failed (pinned=${PINNED_PROVIDER || "none"}): ${preflight.detail}`,
        stage: "gateway_preflight",
      });
      const delivered = await finalizeTerminalStatus({ status: "failed" });
      process.exit(delivered ? 0 : 1);
    }
    log(`gateway preflight ok (pinned to ${PINNED_PROVIDER || "nothing"})`);

    const dockerReady = await ensureDockerReady();
    if (!dockerReady) {
      queueEvent("run.failed", {
        error: `dockerd did not become ready: ${tailFile(DOCKERD_LOG, 4000)}`,
        stage: "sandbox_ready",
      });
      const delivered = await finalizeTerminalStatus({ status: "failed" });
      process.exit(delivered ? 0 : 1);
    }
    queueEvent("run.sandbox_ready", { sandbox_id: os.hostname() });
    // First status transition of the run (issue #23 finding B): posting
    // "running" here, before the task loop starts, closes the window
    // where a run sits at "queued" until its (possibly much later)
    // terminal status -- the callback route's canTransition also allows
    // queued->completed/failed directly as a belt-and-suspenders fallback
    // if this post is ever lost.
    const runningResult = await flushEvents({ status: "running" });
    if (runningResult === null) {
      // Self-healing belt: one immediate retry before any task starts, on
      // top of flushEvents' own carried-forward pendingStatus retry on
      // every later flush.
      await flushEvents();
    }

    // Pull grading materials before any task runs. Fail closed (see
    // fetchTaskTests): without tests we cannot verify, so abort rather than
    // report unscored passes.
    try {
      await fetchTaskTests();
    } catch (err) {
      queueEvent("run.failed", { error: String(err?.message ?? err), stage: "fetch_tests" });
      const delivered = await finalizeTerminalStatus({ status: "failed" });
      process.exit(delivered ? 0 : 1);
    }

    const tasks = JSON.parse(decodeB64(process.env.TASKS_JSON_B64));
    const systemPrompt = decodeB64(process.env.SYSTEM_PROMPT_B64);

    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index];
      if (overBudget) {
        taskResults.push({ task_id: task.id, attempted: false, passed: false });
        continue;
      }

      const result = await runOneTask(task, index, systemPrompt);
      taskResults.push(result);
      cumulativeCost += result.cost_usd ?? 0;

      if (budgetExceeded(cumulativeCost, BUDGET_CAP_USD)) {
        overBudget = true;
        queueEvent("run.budget_exceeded", {
          spent_usd: cumulativeCost,
          cap_usd: BUDGET_CAP_USD,
          tasks_completed: index + 1,
        });
        await flushEvents();
      }
    }

    const totals = computeTotals(taskResults);
    const durationS = (Date.now() - startedAt) / 1000;
    queueEvent("run.completed", {
      tasks_passed: totals.tasks_passed,
      total_cost_usd: totals.total_cost_usd,
      duration_s: durationS,
    });

    await uploadTrace("_run", "runner-log.txt", Buffer.from(runnerLogLines.join("\n"), "utf8"));

    gatewayProxy?.close();
    const delivered = await finalizeTerminalStatus({
      status: "completed",
      totals: { ...totals, over_budget: overBudget },
      task_results: taskResults,
      provider_pinned: resolvePinnedProvider({ configured: PINNED_PROVIDER, applied: pinWasApplied }),
      resolved_system_prompt: resolvedSystemPrompt,
    });
    process.exit(delivered ? 0 : 1);
  } catch (err) {
    gatewayProxy?.close();
    log(`uncaught error: ${err?.stack ?? err}`);
    queueEvent("run.failed", {
      error: String(err?.message ?? err),
      stage: err?.stage ?? "run",
      ...(err?.taskId ? { task_id: err.taskId } : {}),
    });
    try {
      await uploadTrace("_run", "runner-log.txt", Buffer.from(runnerLogLines.join("\n"), "utf8"));
    } catch {
      // best-effort only
    }
    const totals = computeTotals(taskResults);
    const delivered = await finalizeTerminalStatus({
      status: "failed",
      totals: { ...totals, over_budget: overBudget },
      task_results: taskResults,
      provider_pinned: resolvePinnedProvider({ configured: PINNED_PROVIDER, applied: pinWasApplied }),
      resolved_system_prompt: resolvedSystemPrompt,
    });
    process.exit(delivered ? 0 : 1);
  }
}

main();
