import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";
import { vi } from "vitest";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

import { POST } from "./route";

const SECRET = "test-runner-secret";

function traceRequest(runId: string, query: string, body: string, secret: string | null = SECRET): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/octet-stream" };
  if (secret !== null) headers["x-runner-secret"] = secret;
  return new NextRequest(`http://localhost/api/runs/${runId}/trace?${query}`, {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/runs/[id]/trace", () => {
  const originalSecret = process.env.RUNNER_CALLBACK_SECRET;

  beforeEach(() => {
    resetStorage();
    process.env.RUNNER_CALLBACK_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.RUNNER_CALLBACK_SECRET;
    else process.env.RUNNER_CALLBACK_SECRET = originalSecret;
  });

  it("returns 401 when x-runner-secret does not match", async () => {
    const response = await POST(
      traceRequest("run-1", "task_id=t1&name=session.jsonl", "{}", "wrong"),
      { params: Promise.resolve({ id: "run-1" }) },
    );

    expect(response.status).toBe(401);
  });

  it("stores the blob and sets trace_blob_url on the matching task_result when name=session.jsonl", async () => {
    await storageRef.current.putRun({
      id: "run-1",
      submission_id: "sub-1",
      status: "running",
      task_results: [{ task_id: "t1", attempted: true, passed: false }],
      created_at: "2026-07-21T00:00:00.000Z",
    });

    const sessionContent = JSON.stringify({ turn: 1 });
    const response = await POST(
      traceRequest("run-1", "task_id=t1&name=session.jsonl", sessionContent),
      { params: Promise.resolve({ id: "run-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.url).toBe("string");

    const run = await storageRef.current.getRun("run-1");
    const taskResult = run?.task_results.find((tr) => tr.task_id === "t1");
    expect(taskResult?.trace_blob_url).toBe(body.url);
  });

  it("does not set trace_blob_url for non-session trace names (e.g. pi-stdout.txt)", async () => {
    await storageRef.current.putRun({
      id: "run-1",
      submission_id: "sub-1",
      status: "running",
      task_results: [{ task_id: "t1", attempted: true, passed: false }],
      created_at: "2026-07-21T00:00:00.000Z",
    });

    await POST(traceRequest("run-1", "task_id=t1&name=pi-stdout.txt", "stdout dump"), {
      params: Promise.resolve({ id: "run-1" }),
    });

    const run = await storageRef.current.getRun("run-1");
    const taskResult = run?.task_results.find((tr) => tr.task_id === "t1");
    expect(taskResult?.trace_blob_url).toBeUndefined();
  });

  it("returns 404 when the run does not exist", async () => {
    const response = await POST(traceRequest("unknown", "task_id=t1&name=session.jsonl", "x"), {
      params: Promise.resolve({ id: "unknown" }),
    });

    expect(response.status).toBe(404);
  });

  it("rejects unsafe run and task identifiers before storage paths are built", async () => {
    const response = await POST(traceRequest("..", "task_id=../escape&name=session.jsonl", "x"), { params: Promise.resolve({ id: ".." }) });
    expect(response.status).toBe(400);
  });

  it("rejects a chunked body over the byte ceiling despite a misleading content-length", async () => {
    await storageRef.current.putRun({ id: "run-1", submission_id: "sub-1", status: "running", task_results: [], created_at: "2026-07-21T00:00:00.000Z" });
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(3 * 1024 * 1024)); controller.enqueue(new Uint8Array(2 * 1024 * 1024)); } });
    const request = new NextRequest(new Request("http://localhost/api/runs/run-1/trace?task_id=t1&name=session.jsonl", {
      method: "POST", headers: { "x-runner-secret": SECRET, "content-length": "1" }, body: stream, duplex: "half",
    } as RequestInit & { duplex: "half" }));
    expect((await POST(request, { params: Promise.resolve({ id: "run-1" }) })).status).toBe(413);
  });

  describe("regression: unrecognized trace names are rejected, not silently stored", () => {
    it("returns 400 for a name outside the valid set", async () => {
      await storageRef.current.putRun({
        id: "run-1",
        submission_id: "sub-1",
        status: "running",
        task_results: [],
        created_at: "2026-07-21T00:00:00.000Z",
      });

      const response = await POST(
        traceRequest("run-1", "task_id=t1&name=whatever.txt", "x"),
        { params: Promise.resolve({ id: "run-1" }) },
      );

      expect(response.status).toBe(400);
    });
  });

  describe("regression: run-level trace (task_id=_run) with no matching task_result must not throw", () => {
    it("stores the runner-log.txt blob and returns 200 even though no task_result has task_id=_run", async () => {
      await storageRef.current.putRun({
        id: "run-4",
        submission_id: "sub-4",
        status: "running",
        task_results: [],
        created_at: "2026-07-21T00:00:00.000Z",
      });

      const response = await POST(
        traceRequest("run-4", "task_id=_run&name=runner-log.txt", "full runner log"),
        { params: Promise.resolve({ id: "run-4" }) },
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(typeof body.url).toBe("string");
    });
  });
});
