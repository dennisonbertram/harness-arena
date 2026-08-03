import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runLocalSandboxSmoke } from "./local-sandbox-smoke.mjs";

describe("local deterministic HTTP smoke", () => {
  it("fails when the persisted lifecycle is missing a required transition", async () => {
    const state = await mkdtemp(join(tmpdir(), "arena-local-smoke-test-"));
    await mkdir(join(state, "runs"), { recursive: true });
    await writeFile(join(state, "runs", "run-1.json"), JSON.stringify({
      id: "run-1", submission_id: "sub-1", status: "completed", task_results: [], created_at: new Date().toISOString(),
    }));
    const responses = [
      new Response(JSON.stringify({
        ok: true, seeded: true, writable: true, execution_mode: "deterministic-success", development_identity: "seeded",
      }), { status: 200 }),
      new Response(JSON.stringify({ submission_id: "sub-1", run_id: "run-1", run_ids: ["run-1"], status: "queued" }), { status: 200 }),
      new Response(JSON.stringify({ id: "run-1", status: "completed" }), { status: 200 }),
      new Response(JSON.stringify([
        { run_id: "run-1", seq: 1, ts: new Date().toISOString(), type: "run.created", payload: {} },
        { run_id: "run-1", seq: 2, ts: new Date().toISOString(), type: "run.completed", payload: {} },
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
