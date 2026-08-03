// Pure, import-testable helpers used by scripts/runner/runner.mjs. No
// dependencies beyond the node runtime -- everything here works with plain
// strings/objects so it can be unit tested without Docker or a network.
import { execFileSync, spawn } from "node:child_process";

// Sum `usage.cost.total` across assistant messages in a `pi` session JSONL,
// and count how many assistant messages (turns) there were. Ignores
// non-assistant lines and lines that fail to parse as JSON (schema drift /
// truncated writes should degrade gracefully, not crash the run).
//
// A root agent could rewrite its own session JSONL to report a negative
// cost.total and dodge the budget cap -- negative values are clamped to 0
// (never subtracted from the running total) and counted in
// negativeCostCount as a tamper signal for the caller to log/alert on. The
// platform's gateway-credits ledger remains the authoritative spend
// ceiling; this parser is a secondary, spoofable signal.
export const PRICING_VERSION = "inkling-small-2026-08-03-v1";

// Fixed, versioned board rates. These are intentionally separate from Pi's
// provider-reported ledger: totalCost remains the actual billed spend used for
// budget enforcement, while scoreCost makes comparable submissions insensitive
// to a provider changing its retail price.
const NORMALIZED_PRICING = {
  "thinkingmachines/inkling-small": {
    input: 0.5 / 1_000_000,
    output: 1.2 / 1_000_000,
    cacheRead: 0.1 / 1_000_000,
    // Inkling publishes no separate cache-write rate; creation tokens are
    // charged as ordinary prompt input rather than free cache reads.
    cacheWrite: 0.5 / 1_000_000,
  },
};

export function normalizedCostForUsage(model, usage) {
  const pricing = NORMALIZED_PRICING[model];
  if (!pricing) return undefined;
  const fields = [usage?.input, usage?.cacheRead, usage?.cacheWrite, usage?.output];
  if (!fields.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    return undefined;
  }
  return usage.input * pricing.input +
    usage.cacheRead * pricing.cacheRead +
    usage.cacheWrite * pricing.cacheWrite +
    usage.output * pricing.output;
}

export function parseSessionCost(jsonlText, model) {
  let totalCost = 0;
  let turns = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalOutputTokens = 0;
  let negativeCostCount = 0;
  // Count of assistant messages carrying a finite, nonnegative cost.total
  // -- i.e. an actually-usable cost record (issue #23 finding G1). A
  // session can parse as valid JSON line-by-line yet contain zero of
  // these (e.g. `{}`, or only non-assistant turns), which must NOT count
  // as "readable" for cost-accounting purposes.
  let validCostCount = 0;
  // Output usage is captured independently from cost: providers can expose
  // token counts even when their cost ledger is unavailable. It powers the
  // task-level output-token throughput measurement.
  let validOutputTokenCount = 0;
  // A normalized score is valid only when every assistant turn provides the
  // complete required usage record. cacheWrite is optional in Pi usage and is
  // deterministically zero when omitted.
  let validNormalizedUsageCount = 0;
  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type === "message" && obj?.message?.role === "assistant") {
      turns += 1;
      const usage = obj.message.usage;
      const inputTokens = usage?.input;
      const cacheReadTokens = usage?.cacheRead;
      const cacheWriteTokens = usage?.cacheWrite;
      const outputTokens = obj.message.usage?.output;
      if (typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens >= 0) {
        totalOutputTokens += outputTokens;
        validOutputTokenCount += 1;
      }
      const requiredUsage = [inputTokens, outputTokens];
      const hasRequiredUsage = requiredUsage.every(
        (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
      );
      const hasValidCacheRead =
        cacheReadTokens === undefined ||
        (typeof cacheReadTokens === "number" && Number.isFinite(cacheReadTokens) && cacheReadTokens >= 0);
      const hasValidCacheWrite =
        cacheWriteTokens === undefined ||
        (typeof cacheWriteTokens === "number" && Number.isFinite(cacheWriteTokens) && cacheWriteTokens >= 0);
      if (hasRequiredUsage && hasValidCacheRead && hasValidCacheWrite) {
        totalInputTokens += inputTokens;
        totalCacheReadTokens += cacheReadTokens ?? 0;
        totalCacheWriteTokens += cacheWriteTokens ?? 0;
        validNormalizedUsageCount += 1;
      }
      const cost = obj.message.usage?.cost?.total;
      if (typeof cost === "number" && Number.isFinite(cost)) {
        if (cost < 0) {
          negativeCostCount += 1;
        } else {
          totalCost += cost;
          validCostCount += 1;
        }
      }
    }
  }
  const usageComplete = turns > 0 && validNormalizedUsageCount === turns;
  const scoreCost = usageComplete
    ? normalizedCostForUsage(model, {
        input: totalInputTokens,
        cacheRead: totalCacheReadTokens,
        cacheWrite: totalCacheWriteTokens,
        output: totalOutputTokens,
      })
    : undefined;
  return {
    totalCost,
    turns,
    totalInputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    totalOutputTokens,
    negativeCostCount,
    validCostCount,
    validOutputTokenCount,
    validNormalizedUsageCount,
    ...(scoreCost === undefined ? {} : { scoreCost, pricingVersion: PRICING_VERSION }),
  };
}

/**
 * Returns Pi's terminal assistant/provider error, if the session ended on one.
 *
 * Pi exits 0 after a provider stream idle timeout and records the failure only
 * in session JSONL (`stopReason:"error"`). Without inspecting that record the
 * runner verifies an untouched workspace and reports "tests failed", hiding
 * the infrastructure error that actually caused the failure.
 */
export function parseSessionAgentError(jsonlText) {
  let lastAssistant;
  for (const line of String(jsonlText ?? "").split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type === "message" && obj?.message?.role === "assistant") {
      lastAssistant = obj.message;
    }
  }
  if (lastAssistant?.stopReason !== "error") return undefined;
  const error =
    typeof lastAssistant.errorMessage === "string" && lastAssistant.errorMessage.trim()
      ? lastAssistant.errorMessage.trim()
      : "Provider request failed.";
  return {
    stage: /timed?\s*out|timeout/i.test(error) ? "provider_timeout" : "provider_error",
    error,
  };
}

/**
 * Correlates sidecar request logs with the identifiers Pi writes to its own
 * session/stdout traces. The sidecar cannot know Pi's final response id while
 * a request is being opened, so the runner emits this compact join record
 * after the task finishes.
 */
export function parsePiCorrelation(sessionText, stdoutText) {
  const responseIds = [];
  const seenResponseIds = new Set();
  for (const line of String(sessionText ?? "").split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const responseId = obj?.type === "message" && obj?.message?.role === "assistant" ? obj.message.responseId : undefined;
    if (typeof responseId === "string" && responseId && !seenResponseIds.has(responseId)) {
      seenResponseIds.add(responseId);
      responseIds.push(responseId);
    }
  }

  const retryEvents = [];
  for (const line of String(stdoutText ?? "").split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type !== "auto_retry_start") continue;
    retryEvents.push({
      type: obj.type,
      ...(obj.attempt !== undefined ? { attempt: obj.attempt } : {}),
      ...(obj.maxAttempts !== undefined ? { max_attempts: obj.maxAttempts } : {}),
      ...(obj.delayMs !== undefined ? { delay_ms: obj.delayMs } : {}),
      ...(typeof obj.error === "string" ? { error: obj.error } : {}),
      ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
      ...(typeof obj.timestamp === "string" ? { timestamp: obj.timestamp } : {}),
    });
  }
  return { response_ids: responseIds, retry_events: retryEvents };
}

/**
 * Joins each proxy request to its terminal response diagnostic and keeps the
 * compact timing/error fields needed to distinguish an upstream rejection,
 * a first-byte stall, and a mid-stream interruption in persisted run events.
 */
export function summarizeGatewayRequests(events) {
  const requests = events.filter((event) => event.type === "gateway_proxy.request").slice(-128);
  return requests
    .map((request) => {
      const response = events.find(
        (event) => event.type === "gateway_proxy.response_headers" && event.request_id === request.request_id,
      );
      const complete = events.find(
        (event) => event.type === "gateway_proxy.response_complete" && event.request_id === request.request_id,
      );
      const streamError = events.find(
        (event) => event.type === "gateway_proxy.stream_error" && event.request_id === request.request_id,
      );
      const terminal = complete ?? streamError;
      return {
        request_id: request.request_id,
        model: request.model,
        pinned_provider: request.pinned_provider,
        request_bytes: request.request_bytes,
        message_count: request.message_count,
        tool_count: request.tool_count,
        status: response?.status,
        response_id: terminal?.response_id,
        first_byte_at: terminal?.first_byte_at,
        last_byte_at: terminal?.last_byte_at,
        total_bytes: terminal?.total_bytes,
        chunk_count: terminal?.chunk_count,
        max_idle_ms: terminal?.max_idle_ms,
        duration_ms: terminal?.duration_ms,
        ...(complete?.usage === undefined ? {} : { usage: complete.usage }),
        stream_error: boundedGatewayError(streamError?.error),
      };
    });
}

/**
 * Produces a scoring record only from host-side gateway observations. Any
 * missing request, dropped diagnostic, failed response, or incomplete usage
 * makes the entire task unpriced rather than trusting participant-writable
 * session files or inventing zeroes.
 */
export function trustedGatewayPricing({ requests, requestCount, droppedEvents, model }) {
  if (!Array.isArray(requests) || requestCount < 1 || requests.length !== requestCount || droppedEvents !== 0) {
    return undefined;
  }
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const request of requests) {
    if (
      request?.model !== model ||
      !Number.isInteger(request.status) || request.status < 200 || request.status >= 300 ||
      request.stream_error || !request.usage
    ) return undefined;
    const fields = {
      input: request.usage.input_tokens,
      cacheRead: request.usage.cache_read_tokens ?? 0,
      cacheWrite: request.usage.cache_write_tokens ?? 0,
      output: request.usage.output_tokens,
    };
    if (!Object.values(fields).every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
      return undefined;
    }
    for (const key of Object.keys(usage)) usage[key] += fields[key];
  }
  const normalizedCost = normalizedCostForUsage(model, usage);
  if (normalizedCost === undefined) return undefined;
  return { normalizedCost, pricingVersion: PRICING_VERSION, usage, pricingSource: "gateway-proxy" };
}

function boundedGatewayError(error) {
  if (!error || typeof error !== "object") return undefined;
  return {
    name: String(error.name ?? "Error").slice(0, 64),
    message: String(error.message ?? "").slice(0, 256),
    ...(error.code === undefined ? {} : { code: String(error.code).slice(0, 64) }),
  };
}

const TRUNCATION_MARKER = "[TRUNCATED]";

function truncateUtf8(value, maxBytes) {
  const text = String(value);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER);
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > contentBudget) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}${TRUNCATION_MARKER}`;
}

/**
 * Retains a byte- and entry-bounded tail of proxy diagnostics. Request count
 * is aggregated separately so correlation remains exact even when raw detail
 * is evicted. The newest terminal records win over old chunk/request detail.
 */
export function createBoundedGatewayDiagnosticCollector({
  maxEntries = 1_024,
  maxBytes = 512 * 1024,
} = {}) {
  const events = [];
  let retainedBytes = 0;
  let requestCount = 0;
  let droppedEvents = 0;

  function reset() {
    events.length = 0;
    retainedBytes = 0;
    requestCount = 0;
    droppedEvents = 0;
  }

  return {
    push(event) {
      if (event?.type === "gateway_proxy.request") requestCount += 1;
      const eventBytes = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (eventBytes > maxBytes) {
        droppedEvents += 1;
        return;
      }
      while (events.length > 0 && (events.length >= maxEntries || retainedBytes + eventBytes > maxBytes)) {
        const removed = events.shift();
        retainedBytes -= removed.bytes;
        droppedEvents += 1;
      }
      events.push({ event, bytes: eventBytes });
      retainedBytes += eventBytes;
    },
    beginScope() {
      reset();
    },
    drain() {
      const snapshot = {
        events: events.map((entry) => entry.event),
        requestCount,
        droppedEvents,
      };
      reset();
      return snapshot;
    },
  };
}

/**
 * Ring buffer for the run-level uploaded log. Every line is bounded before it
 * is returned to the console caller or retained; the upload string adds one
 * deterministic marker when earlier lines were evicted.
 */
export function createBoundedLogBuffer({
  maxEntries = 2_000,
  maxBytes = 1024 * 1024,
  maxLineBytes = 8 * 1024,
} = {}) {
  const lines = [];
  let droppedLines = 0;

  function marker() {
    return `${TRUNCATION_MARKER} ${droppedLines} earlier log line(s) omitted`;
  }

  function rendered() {
    return (droppedLines > 0 ? [marker(), ...lines] : lines).join("\n");
  }

  function rebalance() {
    const retainedLimit = Math.max(0, maxEntries - (droppedLines > 0 ? 1 : 0));
    while (lines.length > retainedLimit) {
      lines.shift();
      droppedLines += 1;
    }
    while (lines.length > 0 && Buffer.byteLength(rendered()) > maxBytes) {
      lines.shift();
      droppedLines += 1;
    }
  }

  return {
    append(line) {
      const bounded = truncateUtf8(line, Math.min(maxLineBytes, maxBytes));
      lines.push(bounded);
      if (lines.length > maxEntries) {
        lines.shift();
        droppedLines += 1;
      }
      rebalance();
      return bounded;
    },
    toString() {
      rebalance();
      return rendered();
    },
    get length() {
      return lines.length + (droppedLines > 0 ? 1 : 0);
    },
    get byteLength() {
      return Buffer.byteLength(rendered());
    },
  };
}

/** Return one task's diagnostics and release all run-global retained detail. */
export function drainGatewayDiagnostics(events, start = 0) {
  const taskEvents = events.slice(start);
  events.length = 0;
  return taskEvents;
}

// Distinguishes "session unusable for cost accounting" (no assistant
// record with a finite, nonnegative cost.total -- whether because the
// file is missing/empty, every line fails to parse, or it parses fine but
// carries no real cost data, e.g. `{}` or a lone user turn) from "session
// parsed fine and has at least one real cost record" (issue #23 finding
// G1: valid-but-empty/costless JSON used to be misclassified as readable,
// silently reporting an untracked $0 instead of flooring + tamper-signaling).
export function isSessionTextUnreadable(jsonlText) {
  if (jsonlText == null) return true;
  const trimmed = String(jsonlText).trim();
  if (trimmed === "") return true;
  return parseSessionCost(trimmed).validCostCount === 0;
}

// Recover a task's real cost from `pi`'s captured stdout when the session
// JSONL is unreadable (live-run evidence: run 9f4a1b3e -- pi was SIGTERM'd
// by the agent-timeout wrapper before it ever flushed its --session-dir
// JSONL, so the session file was empty even though pi had already written
// real per-turn cost data to stdout). `pi --print --mode json` emits one
// JSON object per line; each assistant turn's FINAL cost lands in a
// `message_end` event, with `message_update` lines carrying in-progress
// partials that must be ignored (summing partials + finals would
// double-count). If no `message_end` line is present at all (pi killed
// mid-first-turn), falls back to the max cumulative cost seen across
// `turn_end` events (turn_end usage is cumulative, so max -- not sum -- is
// the real total spend).
export function parseStdoutCost(stdoutText) {
  if (!stdoutText) return 0;
  let messageEndSum = 0;
  let sawMessageEnd = false;
  let maxTurnEndCumulative = 0;
  let sawTurnEnd = false;

  for (const line of String(stdoutText).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj?.type === "message_end" && obj?.message?.role === "assistant") {
      sawMessageEnd = true;
      const cost = obj.message.usage?.cost?.total;
      if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
        messageEndSum += cost;
      }
    } else if (obj?.type === "turn_end") {
      const cost = obj.usage?.cost?.total;
      if (typeof cost === "number" && Number.isFinite(cost)) {
        sawTurnEnd = true;
        if (cost > maxTurnEndCumulative) maxTurnEndCumulative = cost;
      }
    }
  }

  if (sawMessageEnd) return messageEndSum;
  if (sawTurnEnd) return maxTurnEndCumulative;
  return 0;
}

// Cost-source priority for each task: (a) the session JSONL cost if the
// session parsed as usable, (b) else the real cost recovered from stdout via
// parseStdoutCost if it's a genuine positive number, (c) else UNMEASURED.
//
// We do NOT fabricate a floor value: an invented dollar amount that isn't real
// is worse than an honest "unknown" on a public leaderboard. Reaching (c)
// means neither the session nor stdout carried any cost record — which happens
// when the agent produced no billable turn (a real ~$0) OR when the cost data
// was genuinely lost; we can't tell those apart from here, so we report null
// (unmeasured) rather than claim a number. Note real spend almost always
// leaves a trace in stdout even if the session file is deleted (tamper), so it
// is caught by branch (b); (c) is truly "no signal". totalCost null is carried
// through as an absent cost_usd, and the aggregation treats it as unmeasured.
export function resolveTaskCost({ sessionUnreadable, sessionCost, stdoutCost }) {
  if (!sessionUnreadable) {
    return { totalCost: sessionCost, costSource: "session" };
  }
  if (typeof stdoutCost === "number" && stdoutCost > 0) {
    return { totalCost: stdoutCost, costSource: "stdout" };
  }
  return { totalCost: null, costSource: "unmeasured" };
}

// Pure core of the runner's event-flush retry logic (live-run evidence:
// run 9f4a1b3e stayed status=queued for its entire duration because a
// transient callback POST failure re-queued only the events and silently
// dropped the "running" status passed via `extra` -- it was never
// resent). Given the events to send, any previously-stashed status
// update, and a new `extra` status update (if any this flush), returns
// what to send this time and what to keep pending if the post fails. A
// status is retried on every subsequent flush -- carried in
// `pendingStatus` -- until a post finally succeeds; a new `extra` status
// always supersedes an older still-pending one.
export async function flushWithPendingStatus({ postFn, events, pendingStatus, extra = {} }) {
  const statusToSend = Object.keys(extra).length > 0 ? extra : pendingStatus;
  const body = { events, ...(statusToSend || {}) };
  const result = await postFn(body);
  if (result === null) {
    return { result, pendingStatus: statusToSend ?? null };
  }
  return { result, pendingStatus: null };
}

// Scrub secret values from arbitrary text before it's uploaded as a public
// trace. Scrubs every exact occurrence of each string in `secrets`, plus
// any vck_-prefixed token (Vercel AI Gateway key format) even if it wasn't
// passed in explicitly -- defense in depth against a root agent
// `printenv`-ing the key into its own output.
const VCK_TOKEN_RE = /vck_[A-Za-z0-9]+/g;

export function redactSecrets(text, secrets = []) {
  let result = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret === "") continue;
    result = result.split(secret).join("[REDACTED]");
  }
  return result.replace(VCK_TOKEN_RE, "[REDACTED]");
}

// Shell-out helper: never throws, always returns a result. Pass
// `timeout` (ms) for a bounded per-attempt deadline -- Node's execFileSync
// kills the child with SIGTERM once it elapses, so a wedged command (e.g.
// `docker info` against a stuck daemon) can never block a polling loop
// forever.
export function sh(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, {
      maxBuffer: opts.maxBuffer ?? 20 * 1024 * 1024,
      timeout: opts.timeout,
    });
    return { code: 0, stdout, stderr: Buffer.alloc(0), timedOut: false };
  } catch (err) {
    return {
      code: typeof err.status === "number" ? err.status : 1,
      stdout: err.stdout ?? Buffer.alloc(0),
      stderr: err.stderr ?? Buffer.alloc(0),
      timedOut: err.signal === "SIGTERM",
      error: err,
    };
  }
}

// Async counterpart used for the long-running pi turn. The gateway sidecar
// runs in this same Node process, so using execFileSync for pi starves the
// event loop and prevents the sidecar from accepting pi's model request until
// after the task timeout. Setup/cleanup commands may stay synchronous; the
// model turn itself must not.
export function shAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const captureLimit = opts.maxBuffer ?? 20 * 1024 * 1024;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let capturedBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let spawnError;

    const capture = (chunks, chunk) => {
      const remaining = Math.max(0, captureLimit - capturedBytes);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (chunk.length > remaining) outputTruncated = true;
      const accepted = Math.min(chunk.length, remaining);
      capturedBytes += accepted;
      return accepted;
    };

    // spawn drains stdout/stderr incrementally. execFile buffered both streams
    // internally and killed Pi with ERR_CHILD_PROCESS_STDIO_MAXBUFFER when a
    // reasoning-heavy JSON event stream crossed the capture bound.
    const child = spawn(cmd, args);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += capture(stdoutChunks, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += capture(stderrChunks, chunk);
    });
    child.on("error", (error) => {
      spawnError = error;
    });

    const timer =
      opts.timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, opts.timeout);

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout: Buffer.concat(stdoutChunks, stdoutBytes),
        stderr: Buffer.concat(stderrChunks, stderrBytes),
        timedOut,
        outputTruncated,
        ...(spawnError ? { error: spawnError } : {}),
      });
    });
  });
}

/**
 * Unexpected Pi exits are runner/client failures, not verifier evidence.
 * GNU timeout's 124/137 exits have their own explicit agent-timeout path.
 */
export function agentProcessFailure(result) {
  if (result?.code === 0 || result?.code === 124 || result?.code === 137) return undefined;
  const detail = result?.error?.code ?? result?.error?.message;
  return [
    `Pi process exited with code ${result?.code ?? "unknown"}`,
    detail ? `(${detail})` : undefined,
    result?.outputTruncated ? "after captured output was truncated" : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

// Wrap a fetch call with a request-scoped abort deadline so a hung
// callback endpoint can never block the runner indefinitely. `fetchImpl`
// is injected for testability (no network needed to unit test this).
export function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs) {
  return fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

// Container name: task-${RUN_ID}-${index}-${sanitized task id}. Including
// RUN_ID and index means concurrent runs -- and concurrent tasks within a
// run -- never collide and force-remove each other's containers. Strips
// to the characters Docker allows in container names.
const CONTAINER_NAME_UNSAFE_RE = /[^a-zA-Z0-9_.-]/g;

export function buildContainerName(runId, index, taskId) {
  const safeRunId = String(runId).replace(CONTAINER_NAME_UNSAFE_RE, "-");
  const safeTaskId = String(taskId).replace(CONTAINER_NAME_UNSAFE_RE, "-");
  return `task-${safeRunId}-${index}-${safeTaskId}`;
}

// Run a best-effort cleanup step, swallowing any throw and logging instead
// (issue #23 finding G2). Intended for `finally` blocks: cleanup itself
// throwing must never mask the real task error or flip a failed task into
// crashing the whole run with an unrelated stack trace.
export function safeCleanup(fn, label, log) {
  try {
    fn();
  } catch (err) {
    log(`cleanup failed (${label}): ${err?.message ?? err}`);
  }
}

// Deliver a terminal (completed/failed) status payload via `postFn`
// (expected to already retry/backoff internally and resolve to a
// truthy/falsy delivered flag). If delivery still fails, write the
// payload to `fallbackPath` via `writeFallback` so an out-of-band reaper
// process can reconcile the run's final status, and report
// delivered=false so the caller can exit non-zero instead of silently
// exiting 0 on a lost terminal status.
export async function deliverTerminalStatus({ postFn, payload, writeFallback, fallbackPath }) {
  const delivered = await postFn(payload);
  if (delivered) return true;
  if (writeFallback) {
    writeFallback(fallbackPath, JSON.stringify(payload, null, 2));
  }
  return false;
}

// Sum cost_usd and count passed tasks across the run's task results.
// over_budget is tracked separately by the caller via budgetExceeded (it
// reflects when the cap was crossed, not just the final sum).
export function computeTotals(taskResults) {
  const total_cost_usd = taskResults.reduce((sum, r) => sum + (r.cost_usd || 0), 0);
  const tasks_passed = taskResults.filter((r) => r.passed === true).length;
  const attemptedTasks = taskResults.filter((r) => r.attempted === true);
  const pricingVersions = new Set(attemptedTasks.map((r) => r.pricing_version).filter(Boolean));
  const pricingSources = new Set(attemptedTasks.map((r) => r.pricing_source).filter(Boolean));
  const normalized_total_cost_usd = attemptedTasks.length > 0 && attemptedTasks.every(
    (r) => typeof r.normalized_cost_usd === "number" && Number.isFinite(r.normalized_cost_usd),
  ) && pricingVersions.size === 1
    ? attemptedTasks.reduce((sum, r) => sum + r.normalized_cost_usd, 0)
    : null;
  const pricing_version = normalized_total_cost_usd === null ? undefined : [...pricingVersions][0];
  const pricing_source = normalized_total_cost_usd === null || pricingSources.size !== 1 ? undefined : [...pricingSources][0];
  return { tasks_passed, total_cost_usd, normalized_total_cost_usd, pricing_version, pricing_source };
}

export const AGENT_TRACE_NAMES = Object.freeze(["session.jsonl", "pi-stdout.txt"]);
export const VERIFIER_TRACE_NAME = "verifier.txt";

// Event payload builders are shared with deterministic local execution so the
// zero-provider fixture cannot drift from the real runner's public metrics.
export function buildTaskAgentFinishedEventPayload({
  taskId,
  turns,
  outputTokens,
  normalizedCostFields = {},
  totalCost,
  costSource,
  durationS,
  outputTruncated = false,
}) {
  return {
    task_id: taskId,
    turns,
    ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
    ...normalizedCostFields,
    ...(totalCost === null ? {} : { cost_usd: totalCost }),
    cost_source: costSource,
    duration_s: durationS,
    ...(outputTruncated ? { output_capture_truncated: true } : {}),
  };
}

export function buildTaskVerifiedEventPayload({ taskId, passed, reward, durationS }) {
  return { task_id: taskId, passed, reward, duration_s: durationS };
}

export function buildRunCompletedEventPayload(totals, durationS) {
  return {
    tasks_passed: totals.tasks_passed,
    total_cost_usd: totals.total_cost_usd,
    ...(totals.normalized_total_cost_usd === null ? {} : { normalized_total_cost_usd: totals.normalized_total_cost_usd }),
    ...(totals.pricing_version ? { pricing_version: totals.pricing_version } : {}),
    ...(totals.pricing_source ? { pricing_source: totals.pricing_source } : {}),
    duration_s: durationS,
  };
}

// Cumulative cost check performed after each task completes (spec: budget
// granularity is between tasks, not mid-task).
export function budgetExceeded(spent, cap) {
  return spent > cap;
}

// reward.txt parsing: passed iff the trimmed content parses to a finite
// number >= 1 ("1" or a float like "1.0"). Missing/empty/non-numeric = fail.
export function parseReward(text) {
  if (text == null) return false;
  const trimmed = String(text).trim();
  if (trimmed === "") return false;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 1;
}

// POSIX single-quote shell escaping: wrap in single quotes, and turn any
// embedded single quote into '\'' (close quote, escaped literal quote,
// reopen quote). Safe for arbitrary untrusted content (system prompts,
// task instructions) placed inside a `sh -c "..."` command string.
export function shQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

// Build the shell command run via `docker exec ... sh -c "<this>"` inside
// the task container. Defaults to the resolved pi invocation from the
// architect spike; PI_INVOKE_OVERRIDE (test-only) swaps out the whole pi
// call for a fixture command, still wrapped in the same timeout.
/**
 * pi model config (models.json) that caps output tokens per completion for the
 * arena's fixed model, so a single runaway generation can't stream toward the
 * model's full context ceiling. Written into the task container and loaded via
 * PI_CODING_AGENT_DIR.
 */
export function buildModelsConfig(maxOutputTokens) {
  return JSON.stringify({
    providers: {
      "vercel-ai-gateway": {
        modelOverrides: { "zai/glm-5.2": { maxTokens: maxOutputTokens } },
      },
    },
  });
}

/**
 * Where pi reads custom provider config from, per its own docs/models.md:
 * `~/.pi/agent/models.json` -- NOT `~/.pi/models.json`. Verified by A/B against
 * pi 0.82.1: at the wrong path pi ignored the file and called the real gateway
 * (401 from Vercel, zero traffic to the sidecar); at this path it routed
 * through the sidecar. The wrong path fails silently -- the run still
 * completes, just unpinned -- so nothing surfaced it.
 */
export const PI_MODELS_CONFIG_PATH = "/root/.pi/agent/models.json";
export const PI_SETTINGS_CONFIG_PATH = "/root/.pi/agent/settings.json";
const OPENAI_CHAT_COMPLETIONS_PATH = "/chat/completions";

/**
 * Pi's default HTTP idle timeout is 300 seconds: exactly the runner's entire
 * task deadline. A Fireworks stream that never produces a first token
 * therefore looks like an agent timeout and consumes five minutes. Apply the
 * shorter fail-fast window only to the Fast route for which production
 * demonstrated this failure; leave other models on Pi's native defaults.
 *
 * Keep one retry inside that bounded window. Wafer production runs repeatedly
 * returned an immediate, zero-token `terminated` error on a follow-up turn;
 * with retries disabled each transient upstream failure became a guaranteed
 * failed benchmark task. One retry can recover that turn while adding at most
 * one bounded 60-second wait if a provider becomes silent again.
 */
export function buildPiSettings({ model } = {}) {
  if (model !== "zai/glm-5.2-fast") return undefined;
  return JSON.stringify({
    httpIdleTimeoutMs: 60_000,
    retry: {
      enabled: true,
      maxRetries: 1,
      provider: { maxRetries: 1 },
    },
  });
}

// Pi's OpenAI-compatible client appends /chat/completions to a base URL that
// already includes /v1, matching the gateway's documented endpoint.
export function gatewayProxyBaseUrl({ host, port }) {
  return `http://${host}:${port}/v1`;
}

// Anthropic-compatible clients append /v1/messages themselves. Vercel
// documents the Gateway origin (without /v1) as their base URL; supplying the
// OpenAI-style base instead produces /v1/v1/messages.
export function gatewayProxyRootUrl({ host, port }) {
  return `http://${host}:${port}`;
}

// `models.json` cannot change the transport of a built-in Pi model with a
// provider-level `api` alone. The model must be explicitly upserted through
// `models`, and Pi's upsert does not inherit the built-in model's accounting
// metadata. Preserve the exact metadata shipped by the pinned agentkit rather
// than silently turning usage cost into $0 or shrinking the context window.
const OPENAI_COMPATIBLE_ZAI_MODELS = {
  "zai/glm-5.2": {
    name: "GLM 5.2",
    cost: { input: 1.1, output: 3.851, cacheRead: 0.275, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  "zai/glm-5.2-fast": {
    name: "GLM 5.2 Fast",
    cost: { input: 2.1, output: 6.6, cacheRead: 0.21, cacheWrite: 0 },
    contextWindow: 1_000_000,
    // Production evidence (run e32e1166): Fireworks still generated hidden
    // reasoning with reasoning.enabled=false, and an unlimited turn consumed
    // the full five-minute task window. At the route's advertised 120-250
    // TPS, 8K tokens bounds one completion to roughly a minute at the slow
    // end. Keep this specific to the Fast route: the same cap materially
    // reduced the non-fast GLM baseline score in an earlier A/B.
    maxTokens: 8_192,
  },
};

/**
 * One real model call through the sidecar, before any task starts.
 *
 * The pinning path failed silently in production: pi could not get a usable
 * answer, so every one of the 16 tasks burned its full agent timeout and the
 * run finished with 0 cost and 0 passes. That reads like a catastrophically bad
 * model rather than broken plumbing, and it cost a full run to discover. This
 * turns the same failure into an immediate, named error.
 *
 * Deliberately exercises the sidecar (127.0.0.1:port), not the gateway --
 * calling the gateway directly would prove nothing about the path pi uses.
 */
async function waitForRetry(ms, signal) {
  if (ms <= 0 || signal.aborted) return;
  await new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function preflightProxy({
  port,
  model,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 60_000,
  maxAttempts = 3,
  retryDelayMs = 1_000,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await fetchImpl(
        `${gatewayProxyBaseUrl({ host: "127.0.0.1", port })}${OPENAI_CHAT_COMPLETIONS_PATH}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: 1,
            stream: true,
            messages: [{ role: "user", content: "ping" }],
          }),
          signal: controller.signal,
        },
      );
      // `fetch()` resolves once response headers arrive. The gateway can
      // return HTTP 200 and then never produce a model token; treating headers
      // alone as success lets every real task burn through Pi's retry
      // timeouts. Consume the complete one-token response while the same abort
      // deadline is active so preflight proves generation, not just admission.
      const detail = (await response.text()).slice(0, 300);
      if (response.ok) return { ok: true };

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxAttempts || controller.signal.aborted) {
        return { ok: false, detail: `HTTP ${response.status} ${detail}` };
      }
      await waitForRetry(retryDelayMs, controller.signal);
    }
    return { ok: false, detail: "preflight exhausted without a response" };
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What to record as provider_pinned.
 *
 * Absence of this field is how the board marks a run as not comparable, so it
 * must reflect what HAPPENED, not what was configured. Echoing the env var
 * meant that while the models.json path was wrong -- pi silently ignoring the
 * config and calling the real gateway -- every run was still stamped as pinned.
 * `applied` comes from the sidecar having actually pinned a request.
 */
export function resolvePinnedProvider({ configured, applied }) {
  return configured && applied ? configured : undefined;
}

/**
 * pi models.json that routes the gateway provider through the pinning sidecar.
 *
 * pi cannot add arbitrary body fields, so it cannot send the gateway's
 * `providerOptions.gateway.only` itself. It CAN point a provider at a
 * different baseUrl, so we send it to the local proxy, which injects the pin
 * and forwards. GLM is forced onto Pi's OpenAI-compatible `/v1` transport
 * because the Anthropic Messages stream repeatedly produced zero agent turns
 * across providers in production. Other catalog models keep Pi's own
 * transport and receive the proxy origin, allowing an Anthropic-compatible
 * model such as Inkling to append `/v1/messages` exactly once. See
 * gateway-proxy.mjs.
 *
 * `host.docker.internal` resolves via the --add-host=host-gateway mapping the
 * runner adds to `docker run`: pi executes inside the task container, and the
 * proxy runs on the sandbox VM outside it.
 */
export function buildPinnedModelsConfig({ proxyPort, model }) {
  const modelOverride = model.startsWith("zai/")
    ? {
        reasoning: true,
        compat: { thinkingFormat: "zai" },
      }
    : {};
  const zaiMetadata = OPENAI_COMPATIBLE_ZAI_MODELS[model];
  if (model.startsWith("zai/") && !zaiMetadata) {
    throw new Error(`Missing Pi metadata for OpenAI-compatible model ${model}`);
  }
  const models = zaiMetadata
    ? [
        {
          id: model,
          ...zaiMetadata,
          api: "openai-completions",
          reasoning: true,
          input: ["text"],
        },
      ]
    : undefined;

  return JSON.stringify({
    providers: {
      "vercel-ai-gateway": {
        api: "openai-completions",
        baseUrl: zaiMetadata
          ? gatewayProxyBaseUrl({
              host: "host.docker.internal",
              port: proxyPort,
            })
          : gatewayProxyRootUrl({
              host: "host.docker.internal",
              port: proxyPort,
            }),
        ...(models ? { models } : {}),
        modelOverrides: { [model]: modelOverride },
      },
    },
  });
}

export function buildPiCommand({
  agentTimeoutSec,
  sessionDir,
  promptFile,
  instruction,
  override,
  hasSystemPrompt = true,
  provider = "vercel-ai-gateway",
  model = "zai/glm-5.2",
  thinking,
}) {
  const timeoutPrefix = `timeout --signal=TERM --kill-after=10 ${agentTimeoutSec}`;
  if (override) {
    return `${timeoutPrefix} ${override}`;
  }
  // Match harnessarena.xyz's vanilla pi invocation (agent/pi_agent.py): do NOT
  // pass -nc/-ns/--no-extensions -- those strip pi's context/skills/extensions
  // and diverge from the reference baseline. When there is no submitted system
  // prompt (the baseline), omit --system-prompt entirely so pi uses its own
  // built-in default, exactly like their baseline. Provider/model are
  // configurable (RUNNER_PROVIDER/RUNNER_MODEL) so the fixed board can route
  // through OpenRouter (provider=openrouter, model=z-ai/glm-5.2) exactly like
  // harnessarena, or the Vercel AI Gateway by default.
  const parts = [
    `${timeoutPrefix} /usr/local/bin/pi`,
    "--print --mode json",
    `--session-dir ${shQuote(sessionDir)}`,
    `--provider ${shQuote(provider)} --model ${shQuote(model)}`,
  ];
  if (thinking) {
    parts.push(`--thinking ${shQuote(thinking)}`);
  }
  if (hasSystemPrompt) {
    parts.push(`--system-prompt "$(cat ${shQuote(promptFile)})"`);
  }
  parts.push(shQuote(instruction));
  return parts.join(" ");
}
