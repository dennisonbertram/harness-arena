import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runLocalSandboxSmoke } from "./local-sandbox-smoke.mjs";

describe("local deterministic HTTP smoke", () => {
  it("submits a non-empty prompt and derives exact zero-cost proof from the independent task manifest", async () => {
    const state = await mkdtemp(join(tmpdir(), "arena-local-smoke-success-"));
    const taskId = "manifest-task";
    const traceUrl = "http://127.0.0.1:3000/api/runs/run-1/trace-view?task_id=manifest-task&name=session.jsonl";
    const run = {
      id: "run-1", submission_id: "sub-1", status: "completed", tasks_passed: 1, total_cost_usd: 0,
      over_budget: false,
      task_results: [{
        task_id: taskId, attempted: true, passed: true, reward: 1, cost_usd: 0,
        turns: 1, output_tokens: 8, agent_duration_s: 0.1, duration_s: 0.25, trace_blob_url: traceUrl,
      }],
      created_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    };
    const types = ["run.created", "run.sandbox_creating", "run.sandbox_ready", "task.started", "task.agent_finished", "task.verify_started", "task.verified", "task.trace_uploaded", "task.trace_uploaded", "task.trace_uploaded", "run.completed"];
    const events = types.map((type, index) => ({
      run_id: run.id, seq: index + 1, ts: run.created_at, type,
      payload: type === "task.agent_finished"
        ? { task_id: taskId, turns: 1, output_tokens: 8, cost_usd: 0, duration_s: 0.1 }
        : type === "task.verified"
          ? { task_id: taskId, passed: true, reward: 1, duration_s: 0.15 }
          : type === "run.completed"
            ? { tasks_passed: 1, total_cost_usd: 0, duration_s: 0.25 }
            : type.startsWith("task.") ? { task_id: taskId } : {},
    }));
    await mkdir(join(state, "runs"), { recursive: true });
    await mkdir(join(state, "events"), { recursive: true });
    await mkdir(join(state, "traces", run.id, taskId), { recursive: true });
    await writeFile(join(state, "runs", `${run.id}.json`), JSON.stringify(run));
    await writeFile(join(state, "events", `${run.id}.json`), JSON.stringify(events));
    await writeFile(join(state, "traces", run.id, taskId, "session.jsonl"), "{}\n");
    await writeFile(join(state, "traces", run.id, taskId, "pi-stdout.txt"), "fixture\n");
    await writeFile(join(state, "traces", run.id, taskId, "verifier.txt"), "fixture\n");
    let submittedPrompt;
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/ready") return Response.json({ ok: true, seeded: true, writable: true, execution_mode: "deterministic-success", development_identity: "seeded" });
      if (pathname === "/api/health") return Response.json({ ok: true, storage: "up", gateway_key_present: false });
      if (pathname === "/api/tasks") return Response.json([{ id: taskId, description: "fixture" }]);
      if (pathname === "/api/submissions") {
        submittedPrompt = JSON.parse(options.body).prompt;
        return Response.json({ submission_id: "sub-1", run_id: run.id, run_ids: [run.id], status: "queued", judge_reason: "Approved by deterministic local fairness fixture; no provider request was made." });
      }
      if (pathname === `/api/runs/${run.id}`) return Response.json(run);
      if (pathname === `/api/runs/${run.id}/events`) return Response.json(events);
      if (pathname === `/api/runs/${run.id}/trace-view`) return new Response("{}\n");
      return new Response(null, { status: 404 });
    });

    const result = await runLocalSandboxSmoke({ baseUrl: "http://127.0.0.1:3000", storageRoot: state, fetchImpl });

    expect(submittedPrompt).toBe("Plan carefully, execute the task, and verify the result.");
    expect(result).toMatchObject({ task_count: 1, tasks_passed: 1, total_cost_usd: 0, over_budget: false, trace_count: 1 });
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === "/api/health")).toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === "/api/tasks")).toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === "/api/runs/run-1/trace-view")).toBe(true);
  });

  it("rejects incomplete public runner metrics even when lifecycle event types are complete", async () => {
    const state = await mkdtemp(join(tmpdir(), "arena-local-smoke-metrics-"));
    const taskId = "manifest-task";
    const createdAt = new Date().toISOString();
    const traceUrl = `http://127.0.0.1:3000/api/runs/run-metrics/trace-view?task_id=${taskId}&name=session.jsonl`;
    const run = {
      id: "run-metrics", submission_id: "sub-metrics", status: "completed", tasks_passed: 1, total_cost_usd: 0,
      over_budget: false,
      task_results: [{ task_id: taskId, attempted: true, passed: true, reward: 1, cost_usd: 0, turns: 1, output_tokens: 8, agent_duration_s: 0.1, duration_s: 0.25, trace_blob_url: traceUrl }],
      created_at: createdAt, finished_at: createdAt,
    };
    const eventSpecs = [
      ["run.created", {}], ["run.sandbox_creating", {}], ["run.sandbox_ready", {}],
      ["task.started", { task_id: taskId }],
      ["task.agent_finished", { task_id: taskId, turns: 1, cost_usd: 0, duration_s: 0.1 }],
      ["task.verify_started", { task_id: taskId }],
      ["task.verified", { task_id: taskId, passed: true, reward: 1, duration_s: 0.15 }],
      ["task.trace_uploaded", { task_id: taskId }], ["task.trace_uploaded", { task_id: taskId }], ["task.trace_uploaded", { task_id: taskId }],
      ["run.completed", { tasks_passed: 1, total_cost_usd: 0, duration_s: 0.25 }],
    ];
    const events = eventSpecs.map(([type, payload], index) => ({ run_id: run.id, seq: index + 1, ts: createdAt, type, payload }));
    await mkdir(join(state, "runs"), { recursive: true });
    await mkdir(join(state, "events"), { recursive: true });
    await mkdir(join(state, "traces", run.id, taskId), { recursive: true });
    await writeFile(join(state, "runs", `${run.id}.json`), JSON.stringify(run));
    await writeFile(join(state, "events", `${run.id}.json`), JSON.stringify(events));
    await writeFile(join(state, "traces", run.id, taskId, "session.jsonl"), "{}\n");
    await writeFile(join(state, "traces", run.id, taskId, "pi-stdout.txt"), "fixture\n");
    await writeFile(join(state, "traces", run.id, taskId, "verifier.txt"), "fixture\n");
    const fetchImpl = vi.fn(async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/ready") return Response.json({ ok: true, seeded: true, writable: true, execution_mode: "deterministic-success", development_identity: "seeded" });
      if (pathname === "/api/health") return Response.json({ ok: true, storage: "up", gateway_key_present: false });
      if (pathname === "/api/tasks") return Response.json([{ id: taskId, description: "fixture" }]);
      if (pathname === "/api/submissions") return Response.json({ submission_id: run.submission_id, run_id: run.id, judge_reason: "Approved by deterministic local fairness fixture; no provider request was made." });
      if (pathname === `/api/runs/${run.id}`) return Response.json(run);
      if (pathname === `/api/runs/${run.id}/events`) return Response.json(events);
      if (pathname.endsWith("/trace-view")) return new Response("{}\n");
      return new Response(null, { status: 404 });
    });

    await expect(runLocalSandboxSmoke({ baseUrl: "http://127.0.0.1:3000", storageRoot: state, fetchImpl }))
      .rejects.toThrow(/output_tokens|public runner metrics/i);
  });

  it("rejects observed zero-task success when the independent task manifest is non-empty", async () => {
    const state = await mkdtemp(join(tmpdir(), "arena-local-smoke-mismatch-"));
    const run = { id: "run-1", submission_id: "sub-1", status: "completed", tasks_passed: 0, total_cost_usd: 0, over_budget: false, task_results: [], created_at: new Date().toISOString(), finished_at: new Date().toISOString() };
    const events = ["run.created", "run.sandbox_creating", "run.sandbox_ready", "run.completed"].map((type, index) => ({ run_id: run.id, seq: index + 1, ts: run.created_at, type, payload: {} }));
    await mkdir(join(state, "runs"), { recursive: true });
    await mkdir(join(state, "events"), { recursive: true });
    await writeFile(join(state, "runs", `${run.id}.json`), JSON.stringify(run));
    await writeFile(join(state, "events", `${run.id}.json`), JSON.stringify(events));
    const fetchImpl = vi.fn(async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/ready") return Response.json({ ok: true, seeded: true, writable: true, execution_mode: "deterministic-success", development_identity: "seeded" });
      if (pathname === "/api/health") return Response.json({ ok: true, storage: "up", gateway_key_present: false });
      if (pathname === "/api/tasks") return Response.json([{ id: "required-task", description: "fixture" }]);
      if (pathname === "/api/submissions") return Response.json({ submission_id: "sub-1", run_id: run.id, run_ids: [run.id], status: "queued", judge_reason: "Approved by deterministic local fairness fixture; no provider request was made." });
      if (pathname === `/api/runs/${run.id}`) return Response.json(run);
      if (pathname === `/api/runs/${run.id}/events`) return Response.json(events);
      return new Response(null, { status: 404 });
    });
    await expect(runLocalSandboxSmoke({ baseUrl: "http://127.0.0.1:3000", storageRoot: state, fetchImpl })).rejects.toThrow(/task manifest|task count/i);
  });

  it("fails when the persisted lifecycle is missing a required transition", async () => {
    const state = await mkdtemp(join(tmpdir(), "arena-local-smoke-test-"));
    const createdAt = new Date().toISOString();
    const taskId = "manifest-task";
    const run = {
      id: "run-1", submission_id: "sub-1", status: "completed", tasks_passed: 1, total_cost_usd: 0,
      over_budget: false, task_results: [{ task_id: taskId, attempted: true, passed: true, cost_usd: 0 }],
      created_at: createdAt, finished_at: createdAt,
    };
    await mkdir(join(state, "runs"), { recursive: true });
    await writeFile(join(state, "runs", "run-1.json"), JSON.stringify(run));
    const responses = [
      new Response(JSON.stringify({
        ok: true, seeded: true, writable: true, execution_mode: "deterministic-success", development_identity: "seeded",
      }), { status: 200 }),
      Response.json({ ok: true, storage: "up", gateway_key_present: false }),
      Response.json([{ id: taskId, description: "fixture" }]),
      Response.json({ submission_id: "sub-1", run_id: "run-1", run_ids: ["run-1"], status: "queued", judge_reason: "Approved by deterministic local fairness fixture; no provider request was made." }),
      Response.json(run),
      new Response(JSON.stringify([
        { run_id: "run-1", seq: 1, ts: createdAt, type: "run.created", payload: {} },
        { run_id: "run-1", seq: 2, ts: createdAt, type: "run.completed", payload: {} },
      ]), { status: 200 }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift());

    await expect(runLocalSandboxSmoke({
      baseUrl: "http://127.0.0.1:3000",
      storageRoot: state,
      fetchImpl,
      timeoutMs: 100,
    })).rejects.toThrow(/run\.sandbox_creating|run\.sandbox_ready/);
  });
});
