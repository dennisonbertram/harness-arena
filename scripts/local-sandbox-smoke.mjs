import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_RUN_EVENTS = ["run.created", "run.sandbox_creating", "run.sandbox_ready", "run.completed"];
const REQUIRED_TASK_EVENTS = ["task.started", "task.agent_finished", "task.verify_started", "task.verified", "task.trace_uploaded"];

async function jsonResponse(response, label) {
  if (!response?.ok) throw new Error(`${label} failed (${response?.status ?? "no response"})`);
  return response.json();
}

function assertLifecycle(run, events) {
  const types = events.map((event) => event.type);
  for (const required of REQUIRED_RUN_EVENTS) {
    if (!types.includes(required)) throw new Error(`local smoke missing required transition ${required}`);
  }
  for (const result of run.task_results ?? []) {
    for (const required of REQUIRED_TASK_EVENTS) {
      if (!events.some((event) => event.type === required && event.payload?.task_id === result.task_id)) {
        throw new Error(`local smoke missing ${required} for task ${result.task_id}`);
      }
    }
  }
  for (let index = 0; index < events.length; index++) {
    if (events[index].seq !== index + 1) throw new Error("local smoke event sequence is not contiguous");
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

  const submission = await jsonResponse(await fetchImpl(`${origin}/api/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_name: "deterministic-local-smoke", prompt: "" }),
  }), "submission");
  if (!submission.submission_id || !submission.run_id) throw new Error("local smoke submission response missing identifiers");

  const deadline = Date.now() + timeoutMs;
  let run;
  while (Date.now() < deadline) {
    run = await jsonResponse(await fetchImpl(`${origin}/api/runs/${submission.run_id}`, { cache: "no-store" }), "run read");
    if (["completed", "failed", "reaped"].includes(run.status)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  if (run?.status !== "completed") throw new Error(`local smoke did not complete successfully (status ${run?.status ?? "unknown"})`);
  const events = await jsonResponse(await fetchImpl(`${origin}/api/runs/${submission.run_id}/events`, { cache: "no-store" }), "event read");
  assertLifecycle(run, events);

  const persistedRun = JSON.parse(await readFile(join(resolve(storageRoot), "runs", `${submission.run_id}.json`), "utf8"));
  const persistedEvents = JSON.parse(await readFile(join(resolve(storageRoot), "events", `${submission.run_id}.json`), "utf8"));
  if (persistedRun.status !== run.status) throw new Error("local smoke persisted run does not match HTTP state");
  if (persistedEvents.length !== events.length) throw new Error("local smoke persisted events do not match HTTP state");
  assertLifecycle(persistedRun, persistedEvents);
  for (const result of persistedRun.task_results ?? []) {
    await readFile(join(resolve(storageRoot), "traces", submission.run_id, result.task_id, "session.jsonl"));
  }
  return {
    ok: true,
    mode: "deterministic-local-smoke",
    submission_id: submission.submission_id,
    run_id: submission.run_id,
    status: persistedRun.status,
    event_count: persistedEvents.length,
    task_count: persistedRun.task_results.length,
    total_cost_usd: persistedRun.total_cost_usd,
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
