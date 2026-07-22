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
import {
  budgetExceeded,
  buildContainerName,
  buildPiCommand,
  computeTotals,
  deliverTerminalStatus,
  fetchWithTimeout,
  flushWithPendingStatus,
  isSessionTextUnreadable,
  parseReward,
  parseSessionCost,
  parseStdoutCost,
  redactSecrets,
  resolveTaskCost,
  safeCleanup,
  sh,
  truncateForUpload,
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
const RUNNER_MODEL = process.env.RUNNER_MODEL || "zai/glm-5.2";
// Safety ceiling only, NOT the metric: raised 2->10 so a fuller (costlier)
// solution can complete the whole test instead of being killed mid-run, which
// would deflate its pass rate. Sandbox.ts passes the real value; this default
// is the fallback.
const BUDGET_CAP_USD = parseFloat(process.env.BUDGET_CAP_USD ?? "10");
// Cap on the bytes of a trace actually UPLOADED to the callback (live-run
// evidence: run 9f4a1b3e -- "callback POST failed ... trace?task_id=regex-log&name=pi-stdout.txt:
// HTTP 413", pi stdout exceeded Vercel's ~4.5MB function body limit). Does
// not affect the local 5MB capture used for cost parsing.
const TRACE_UPLOAD_MAX_BYTES = parseInt(process.env.RUNNER_TRACE_UPLOAD_MAX_BYTES ?? "262144", 10);
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

async function uploadTrace(taskId, name, buffer) {
  const url = `${CALLBACK_BASE}/api/runs/${RUN_ID}/trace?task_id=${encodeURIComponent(taskId)}&name=${encodeURIComponent(name)}`;
  return postWithRetry(url, buffer, false);
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
      "--name",
      containerName,
      task.image,
      "sh",
      "-c",
      `sleep ${task.agent_timeout_sec + 900}`,
    ]);

    if (PI_INSTALL_MODE === "agentkit") {
      sh(DOCKER_CMD, ["cp", AGENTKIT_TGZ, `${containerName}:/tmp/agentkit.tgz`]);
      sh(DOCKER_CMD, ["exec", containerName, "tar", "-xzf", "/tmp/agentkit.tgz", "-C", "/usr/local"]);
    }

    // NOTE: an earlier version wrote a pi models.json here capping maxTokens
    // (anti-runaway). It backfired badly: glm-5.2 does very heavy hidden
    // thinking, and an 8192-token output cap starved its real work, so the
    // agent quit after a few turns and the 16-task baseline scored 2/16
    // instead of ~10/16 (a with/without-config A/B on fix-git showed 15 turns
    // vanilla vs a few turns capped). The 16-task ranked set contains no
    // runaway tasks, so the cap has no upside here. Removed — pi runs with its
    // own defaults, matching harnessarena.xyz's vanilla baseline. Bound
    // runaways at the runner level (agent timeout) instead if it recurs.
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
    });

    // `-e AI_GATEWAY_API_KEY` (no `=value`) makes docker exec pass the value
    // through from this process's own environment -- execFileSync inherits
    // process.env by default, so no extra plumbing is needed here. maxBuffer is
    // large (64MB): a verbose pi run streamed ~5.2MB and the old 5MB cap threw
    // (ENOBUFS), killing pi mid-task -- the "0-turn crash" tasks.
    const execResult = sh(
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
    const piStdout = capAt(Buffer.concat([execResult.stdout, execResult.stderr]), 5 * 1024 * 1024);
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
      cost_usd: totalCost,
      cost_source: costSource,
      duration_s: (agentFinishedAt - taskStart) / 1000,
    });
    await flushEvents();

    // Verification against a clean copy of the task's tests.
    sh(DOCKER_CMD, ["exec", containerName, "rm", "-rf", "/tests"]);
    sh(DOCKER_CMD, ["cp", path.join(RUNNER_TASKS_DIR, task.id, "tests"), `${containerName}:/tests`]);
    sh(DOCKER_CMD, ["exec", containerName, "mkdir", "-p", "/logs/verifier"]);

    queueEvent("task.verify_started", { task_id: task.id });
    await flushEvents();

    const verifyStart = Date.now();
    sh(
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
    // own session/stdout, and these traces are uploaded publicly. Cost was
    // already parsed from the FULL piStdout above; the bytes actually
    // uploaded are capped to TRACE_UPLOAD_MAX_BYTES (live-run evidence: run
    // 9f4a1b3e, HTTP 413 uploading pi-stdout.txt past Vercel's ~4.5MB
    // function body limit).
    const secrets = [process.env.AI_GATEWAY_API_KEY].filter(Boolean);
    let traceBlobUrl;
    const redactedSession = redactSecrets(sessionText, secrets);
    const sessionUpload = await uploadTrace(
      task.id,
      "session.jsonl",
      truncateForUpload(Buffer.from(redactedSession, "utf8"), TRACE_UPLOAD_MAX_BYTES),
    );
    if (sessionUpload?.url) {
      traceBlobUrl = sessionUpload.url;
      queueEvent("task.trace_uploaded", { task_id: task.id, blob_url: sessionUpload.url });
    }
    const redactedStdout = Buffer.from(redactSecrets(piStdout.toString("utf8"), secrets), "utf8");
    const stdoutUpload = await uploadTrace(
      task.id,
      "pi-stdout.txt",
      truncateForUpload(redactedStdout, TRACE_UPLOAD_MAX_BYTES),
    );
    if (stdoutUpload?.url) {
      queueEvent("task.trace_uploaded", { task_id: task.id, blob_url: stdoutUpload.url });
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
  try {
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

    const tasks = JSON.parse(decodeB64(process.env.TASKS_JSON_B64));
    const systemPrompt = decodeB64(process.env.SYSTEM_PROMPT_B64);

    const taskResults = [];
    let cumulativeCost = 0;
    let overBudget = false;

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

    const delivered = await finalizeTerminalStatus({
      status: "completed",
      totals: { ...totals, over_budget: overBudget },
      task_results: taskResults,
    });
    process.exit(delivered ? 0 : 1);
  } catch (err) {
    log(`uncaught error: ${err?.stack ?? err}`);
    queueEvent("run.failed", { error: String(err?.message ?? err), stage: "run" });
    try {
      await uploadTrace("_run", "runner-log.txt", Buffer.from(runnerLogLines.join("\n"), "utf8"));
    } catch {
      // best-effort only
    }
    const delivered = await finalizeTerminalStatus({ status: "failed" });
    process.exit(delivered ? 0 : 1);
  }
}

main();
