// Pure, import-testable helpers used by scripts/runner/runner.mjs. No
// dependencies beyond the node runtime -- everything here works with plain
// strings/objects so it can be unit tested without Docker or a network.
import { execFileSync } from "node:child_process";

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
export function parseSessionCost(jsonlText) {
  let totalCost = 0;
  let turns = 0;
  let negativeCostCount = 0;
  // Count of assistant messages carrying a finite, nonnegative cost.total
  // -- i.e. an actually-usable cost record (issue #23 finding G1). A
  // session can parse as valid JSON line-by-line yet contain zero of
  // these (e.g. `{}`, or only non-assistant turns), which must NOT count
  // as "readable" for cost-accounting purposes.
  let validCostCount = 0;
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
  return { totalCost, turns, negativeCostCount, validCostCount };
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
  return { tasks_passed, total_cost_usd };
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
export function buildPiCommand({
  agentTimeoutSec,
  sessionDir,
  promptFile,
  instruction,
  override,
}) {
  if (override) {
    return `timeout ${agentTimeoutSec} ${override}`;
  }
  return [
    `timeout ${agentTimeoutSec} /usr/local/bin/pi`,
    "--print --mode json",
    `--session-dir ${shQuote(sessionDir)}`,
    "-nc -ns --no-extensions",
    "--provider vercel-ai-gateway --model zai/glm-5.2",
    `--system-prompt "$(cat ${shQuote(promptFile)})"`,
    shQuote(instruction),
  ].join(" ");
}
