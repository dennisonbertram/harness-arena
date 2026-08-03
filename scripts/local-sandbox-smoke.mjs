import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const PROMPT = "Plan carefully, execute the task, and verify the result.";
const JUDGE_REASON = "Approved by deterministic local fairness fixture; no provider request was made.";
const RUN_PREFIX = ["run.created", "run.sandbox_creating", "run.sandbox_ready"];
const TASK_EVENTS = ["task.started", "task.agent_finished", "task.verify_started", "task.verified", "task.trace_uploaded"];
const PUBLIC_EVENT_FIELDS = {
  "task.started": ["task_id", "index"],
  "task.agent_finished": ["task_id", "turns", "output_tokens", "cost_usd", "duration_s"],
  "task.verify_started": ["task_id"],
  "task.verified": ["task_id", "passed", "reward", "duration_s"],
  "task.trace_uploaded": ["task_id"],
};

async function jsonResponse(response, label) {
  if (!response?.ok) throw new Error(`${label} failed (${response?.status ?? "no response"})`);
  return response.json();
}

function assertExactTaskResults(run, taskIds) {
  const results = run.task_results ?? [];
  if (results.length !== taskIds.length) throw new Error("local smoke task count does not match independent task manifest");
  if (JSON.stringify(results.map((result) => result.task_id)) !== JSON.stringify(taskIds)) {
    throw new Error("local smoke task results do not match independent task manifest");
  }
  if (!results.every((result) => result.attempted === true && result.passed === true && result.cost_usd === 0)) {
    throw new Error("local smoke task result proof is incomplete");
  }
  if (run.tasks_passed !== taskIds.length || run.total_cost_usd !== 0 || run.over_budget !== false) {
    throw new Error("local smoke totals do not prove exact zero-cost success");
  }
}

function publicEvent(event) {
  const payload = {};
  for (const field of PUBLIC_EVENT_FIELDS[event.type] ?? []) {
    const value = event.payload?.[field];
    if (["string", "number", "boolean"].includes(typeof value)) payload[field] = value;
  }
  return { ...event, payload };
}

function assertLifecycle(run, events, taskIds) {
  const expectedTypes = [
    ...RUN_PREFIX,
    ...taskIds.flatMap(() => TASK_EVENTS),
    "run.completed",
  ];
  const actualTypes = events.map((event) => event.type);
  if (JSON.stringify(actualTypes) !== JSON.stringify(expectedTypes)) {
    const mismatch = expectedTypes.findIndex((type, index) => actualTypes[index] !== type);
    throw new Error(`local smoke lifecycle expected ${expectedTypes[mismatch] ?? "no additional event"} at sequence ${mismatch + 1}`);
  }
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.seq !== index + 1) throw new Error("local smoke event sequence is not contiguous");
    const expectedTaskIndex = Math.floor((index - RUN_PREFIX.length) / TASK_EVENTS.length);
    if (index >= RUN_PREFIX.length && index < events.length - 1
      && event.payload?.task_id !== taskIds[expectedTaskIndex]) {
      throw new Error("local smoke task lifecycle order does not match the task manifest");
    }
  }
  const createdAt = Date.parse(run.created_at);
  const finishedAt = Date.parse(run.finished_at);
  if (!Number.isFinite(createdAt) || !Number.isFinite(finishedAt) || finishedAt < createdAt) {
    throw new Error("local smoke run timestamps are inconsistent");
  }
  let previous = createdAt;
  for (const event of events) {
    const timestamp = Date.parse(event.ts);
    if (!Number.isFinite(timestamp) || timestamp < previous || timestamp > finishedAt) {
      throw new Error("local smoke event timestamps are inconsistent with run completion");
    }
    previous = timestamp;
  }
}

export async function runLocalSandboxSmoke({
  baseUrl,
  storageRoot,
  fetchImpl = fetch,
  timeoutMs = 15_000,
}) {
  const origin = new URL(baseUrl).origin;
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(new URL(origin).hostname)) {
    throw new Error("local smoke requires a loopback HTTP origin");
  }
  const ready = await jsonResponse(await fetchImpl(`${origin}/api/ready`, { cache: "no-store" }), "readiness");
  if (!ready.ok || ready.seeded !== true || ready.writable !== true
    || ready.execution_mode !== "deterministic-success" || ready.development_identity !== "seeded") {
    throw new Error("local smoke readiness proof incomplete");
  }
  const health = await jsonResponse(await fetchImpl(`${origin}/api/health`, { cache: "no-store" }), "health");
  if (!health.ok || health.storage !== "up" || health.gateway_key_present !== false) {
    throw new Error("local smoke health does not prove isolated zero-provider execution");
  }
  const tasks = await jsonResponse(await fetchImpl(`${origin}/api/tasks`, { cache: "no-store" }), "task manifest");
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.some((task) => typeof task.id !== "string" || !task.id)) {
    throw new Error("local smoke task manifest is empty or invalid");
  }
  const taskIds = tasks.map((task) => task.id);
  if (new Set(taskIds).size !== taskIds.length) throw new Error("local smoke task manifest contains duplicate IDs");

  const submission = await jsonResponse(await fetchImpl(`${origin}/api/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_name: "deterministic-local-smoke", prompt: PROMPT }),
  }), "submission");
  if (!submission.submission_id || !submission.run_id) throw new Error("local smoke submission response missing identifiers");
  if (submission.judge_reason !== JUDGE_REASON) throw new Error("local smoke did not use the deterministic no-provider judge");

  const deadline = Date.now() + timeoutMs;
  let run;
  while (Date.now() < deadline) {
    run = await jsonResponse(await fetchImpl(`${origin}/api/runs/${submission.run_id}`, { cache: "no-store" }), "run read");
    if (["completed", "failed", "reaped"].includes(run.status)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  if (run?.status !== "completed") throw new Error(`local smoke did not complete successfully (status ${run?.status ?? "unknown"})`);
  assertExactTaskResults(run, taskIds);
  const events = await jsonResponse(await fetchImpl(`${origin}/api/runs/${submission.run_id}/events`, { cache: "no-store" }), "event read");
  assertLifecycle(run, events, taskIds);

  const root = resolve(storageRoot);
  const persistedRun = JSON.parse(await readFile(join(root, "runs", `${submission.run_id}.json`), "utf8"));
  const persistedEvents = JSON.parse(await readFile(join(root, "events", `${submission.run_id}.json`), "utf8"));
  if (JSON.stringify(persistedRun) !== JSON.stringify(run)) throw new Error("local smoke persisted run does not match HTTP state");
  if (JSON.stringify(persistedEvents.map(publicEvent)) !== JSON.stringify(events)) {
    throw new Error("local smoke persisted events do not match the public HTTP event projection");
  }
  assertExactTaskResults(persistedRun, taskIds);
  assertLifecycle(persistedRun, persistedEvents, taskIds);

  const traceRoot = join(root, "traces", submission.run_id);
  const traceTaskIds = (await readdir(traceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (JSON.stringify(traceTaskIds) !== JSON.stringify([...taskIds].sort())) {
    throw new Error("local smoke persisted trace set does not match the task manifest");
  }
  for (const result of persistedRun.task_results) {
    await readFile(join(traceRoot, result.task_id, "session.jsonl"));
    if (!result.trace_blob_url) throw new Error(`local smoke missing trace URL for task ${result.task_id}`);
    const traceUrl = new URL(result.trace_blob_url);
    if (traceUrl.origin !== origin) throw new Error(`local smoke trace URL has the wrong origin for task ${result.task_id}`);
    await jsonResponse(await fetchImpl(traceUrl, { cache: "no-store" }).then(async (response) => ({
      ok: response.ok,
      status: response.status,
      json: async () => ({ text: await response.text() }),
    })), `trace read for ${result.task_id}`);
  }
  return {
    ok: true,
    mode: "deterministic-local-smoke",
    submission_id: submission.submission_id,
    run_id: submission.run_id,
    status: persistedRun.status,
    event_count: persistedEvents.length,
    task_count: persistedRun.task_results.length,
    tasks_passed: persistedRun.tasks_passed,
    total_cost_usd: persistedRun.total_cost_usd,
    over_budget: persistedRun.over_budget,
    trace_count: traceTaskIds.length,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const baseUrl = args[args.indexOf("--base-url") + 1];
  const storageRoot = args[args.indexOf("--storage-root") + 1];
  if (!baseUrl || !storageRoot) throw new Error("usage: node scripts/local-sandbox-smoke.mjs --base-url <loopback-url> --storage-root <path>");
  process.stdout.write(`${JSON.stringify(await runLocalSandboxSmoke({ baseUrl, storageRoot }))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
