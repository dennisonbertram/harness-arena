// Pure, import-testable helpers used by scripts/runner/runner.mjs. No
// dependencies beyond the node runtime -- everything here works with plain
// strings/objects so it can be unit tested without Docker or a network.

// Sum `usage.cost.total` across assistant messages in a `pi` session JSONL,
// and count how many assistant messages (turns) there were. Ignores
// non-assistant lines and lines that fail to parse as JSON (schema drift /
// truncated writes should degrade gracefully, not crash the run).
export function parseSessionCost(jsonlText) {
  let totalCost = 0;
  let turns = 0;
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
        totalCost += cost;
      }
    }
  }
  return { totalCost, turns };
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
