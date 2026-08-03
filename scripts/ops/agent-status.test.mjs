import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  EXIT_CODES,
  collectAgentOpsStatus,
  collectPlatformEvidence,
  createGitHubCommandAdapter,
  createVercelCommandAdapter,
  executeCli,
  formatHumanStatus,
  parseCliArgs,
  parseGitHubExpectedSha,
  parseVercelEnvironment,
  parseVercelInspect,
  parseVercelList,
  parseVercelLogs,
  redactSensitive,
  requestOpsJson,
  spawnCommand,
} from "./agent-status.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hardBound = async (promise, timeoutMs = 150) => {
  const timedOut = Symbol("timed-out");
  return Promise.race([promise, delay(timeoutMs).then(() => timedOut)]);
};

function healthyApiFetch({ missingCursor = false, missingHasMore = false, missingTerminalCursor = false, unknownFreshness = false, healthOk = true, advertisedKinds, runCount, runRecords, integrity, serverPageLimit = false } = {}) {
  return vi.fn(async (rawUrl, init) => {
    expect(init.method).toBe("GET");
    const url = new URL(rawUrl);
    if (url.pathname === "/api/health") return jsonResponse({ ok: healthOk, sha: "abc123", storage: "up", gateway_key_present: true, runner_secret_present: true });
    if (url.pathname === "/api/ops/v1") return jsonResponse({ schema_version: "ops.v1", kinds: advertisedKinds ?? [{ kind: "runs" }, { kind: "events" }, { kind: "competitions" }], inventory: "/api/ops/v1/inventory", read: "/api/ops/v1/read", summary: "/api/ops/v1/summary" });
    if (url.pathname === "/api/ops/v1/summary") return jsonResponse({ schema_version: "ops.v1", scan: { complete: true }, latest: { runs: unknownFreshness ? null : "2026-08-03T00:05:00.000Z", events: "2026-08-03T00:06:00.000Z" }, run_states: { queued: 0, running: 1, failed: 0, stale: 0 }, integrity: integrity ?? { unreadable: 0, corrupt: 0, event_holes: 0 } });
    if (url.pathname === "/api/ops/v1/inventory") {
      const kind = url.searchParams.get("kind"), cursor = url.searchParams.get("cursor");
      if (kind === "runs" && serverPageLimit) return jsonResponse({ schema_version: "ops.v1", kind, error: { code: "page_item_limit", limit: 100, received: 101 }, partial: true }, 503);
      if (kind === "runs" && runRecords) return jsonResponse({ schema_version: "ops.v1", kind, items: runRecords, has_more: false, next_cursor: null });
      if (kind === "runs" && runCount) return jsonResponse({ schema_version: "ops.v1", kind, items: Array.from({ length: runCount }, (_, index) => ({ pathname: `runs/r${index + 1}.json`, uploaded_at: "2026-08-03T00:05:00.000Z" })), has_more: false, next_cursor: null });
      if (kind === "runs" && !cursor) return jsonResponse({ schema_version: "ops.v1", kind, items: [{ pathname: "runs/r1.json", uploaded_at: "2026-08-03T00:05:00.000Z" }], ...(missingHasMore ? {} : { has_more: true }), next_cursor: missingCursor ? null : "runs-2" });
      if (kind === "runs") return jsonResponse({ schema_version: "ops.v1", kind, items: [{ pathname: "runs/r2.json", uploaded_at: "2026-08-03T00:04:00.000Z" }], has_more: false, ...(missingTerminalCursor ? {} : { next_cursor: null }) });
      if (kind === "events") return jsonResponse({ schema_version: "ops.v1", kind, items: [{ pathname: "events/r1/0000000002.json", uploaded_at: "2026-08-03T00:06:00.000Z" }, { pathname: "events/r2/0000000003.json", uploaded_at: "2026-08-03T00:06:00.000Z" }], has_more: false, next_cursor: null });
      return jsonResponse({ schema_version: "ops.v1", kind, items: [{ pathname: "competitions/c1.json", uploaded_at: "2026-08-03T00:01:00.000Z" }], has_more: false, next_cursor: null });
    }
    if (url.pathname === "/api/ops/v1/read" && url.searchParams.get("kind") === "runs") {
      const id = url.searchParams.get("id");
      return jsonResponse({ schema_version: "ops.v1", kind: "runs", item: { id, status: id === "r1" ? "running" : "completed", sandbox_id: id === "r1" ? "sbx-1" : "sbx-2", callback_status: "delivered", total_cost_usd: 1.25, task_results: [{ passed: true }, { passed: false }], provider: "vercel-ai-gateway", model: "test/model" } });
    }
    if (url.pathname === "/api/ops/v1/read" && url.searchParams.get("kind") === "events") return jsonResponse({ schema_version: "ops.v1", kind: "events", item: { type: "task.completed", action: "judge", created_at: "2026-08-03T00:06:00.000Z" } });
    throw new Error(`unexpected URL ${url}`);
  });
}

const healthyPlatform = {
  state: "ok",
  expected_sha: "abc123",
  deployment: { hostname: "arena.example", id: "dpl_1", state: "READY", created_at: "2026-08-03T00:00:00.000Z", ref: "main", sha: "abc123", git_dirty: false },
  environment: { records: [], required_missing: [] },
  logs: { recent_errors: [] },
  cron: { state: "configured" },
  command_provenance: [],
};

describe("CLI contract and command safety", () => {
  it("implements the documented production invocation and safe environment mapping", () => {
    expect(parseCliArgs(["--env", "production", "--json"], {})).toMatchObject({ environment: "production", json: true, expected_ref: "main", collect_platform: true });
    expect(parseCliArgs(["--env", "development"], {})).toMatchObject({ environment: "development", json: false, expected_ref: "dev", collect_platform: true });
    expect(parseCliArgs(["--env", "local"], {})).toMatchObject({ environment: "local", collect_platform: false, base_url: "http://127.0.0.1:3000" });
    expect(() => parseCliArgs(["--env", "staging"], {})).toThrow("invalid_environment");
    expect(() => parseCliArgs(["--env", "production"], { HARNESS_ARENA_PRODUCTION_URL: "https://user:pass@arena.example" })).toThrow("invalid_base_url");
  });

  it("uses exact Vercel argv grammars and rejects mutation and option injection", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "", exitCode: 0 });
    const adapter = createVercelCommandAdapter(run);
    await expect(adapter.run(["ls", "--json", "--environment", "production"])).resolves.toMatchObject({ exitCode: 0 });
    for (const args of [["env", "rm", "FOO", "production"], ["env", "add", "FOO", "production"], ["inspect", "--token=leak", "--json"], ["logs", "--evil", "--json", "--since", "1h"], ["deploy"], ["alias"], ["promote"], ["rollback"]]) await expect(adapter.run(args)).rejects.toThrow("unsafe_vercel_command");
    expect(run).toHaveBeenCalledWith("vercel", ["ls", "--json", "--environment", "production"], expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });

  it("uses an exact read-only GitHub expected-SHA grammar", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "abc123\n", stderr: "", exitCode: 0 });
    const adapter = createGitHubCommandAdapter(run);
    await expect(adapter.expectedSha("main")).resolves.toMatchObject({ exitCode: 0 });
    expect(run).toHaveBeenCalledWith("gh", ["api", "repos/dennisonbertram/harness-arena/commits/main", "--jq", ".sha"], expect.any(Object));
    await expect(adapter.expectedSha("--hostname=evil")).rejects.toThrow("unsafe_github_ref");
  });
});

describe("fixture-driven evidence parsers", () => {
  it("parses Vercel list metadata", () => expect(parseVercelList(fixture("vercel-list.json"))).toMatchObject({ deployments: [{ hostname: "arena.example", id: "dpl_1", state: "READY", ref: "main", sha: "abc123", git_dirty: false }] }));
  it("parses Vercel inspect metadata and cron capability", () => expect(parseVercelInspect(fixture("vercel-inspect.json"))).toMatchObject({ deployment: { hostname: "arena.example", id: "dpl_1", created_at: "2026-08-03T00:00:00.000Z", ref: "main", sha: "abc123", git_dirty: false }, cron: { state: "configured" } }));
  it("parses environment metadata without values and reports required names", () => {
    const parsed = parseVercelEnvironment(fixture("vercel-env.json"), "production");
    expect(parsed).toMatchObject({ records: expect.arrayContaining([{ name: "OPS_READ_TOKEN", targets: ["production"], type: "encrypted", created_at: expect.any(String), age_ms: expect.any(Number) }]), required_missing: ["OPS_READ_CURSOR_SECRET"] });
    expect(JSON.stringify(parsed)).not.toContain("super-secret-value");
  });
  it("parses recent Vercel errors from bounded NDJSON", () => expect(parseVercelLogs(fixture("vercel-logs.ndjson"))).toMatchObject({ recent_errors: [{ level: "error", status_code: 503, message: "gateway failed Bearer [REDACTED]" }] }));
  it("parses only a complete expected GitHub SHA", () => { expect(parseGitHubExpectedSha(fixture("github-sha.txt"))).toBe("abc123"); expect(() => parseGitHubExpectedSha("main\nabc123")).toThrow("invalid_expected_sha"); });

  it("maps requested environments to actual Vercel metadata targets", async () => {
    const commandRunner = vi.fn(async (binary, args) => {
      if (binary === "gh") return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      if (args[0] === "ls") return { stdout: fixture("vercel-list.json"), stderr: "", exitCode: 0 };
      if (args[0] === "inspect") return { stdout: fixture("vercel-inspect.json"), stderr: "", exitCode: 0 };
      if (args[0] === "env") return { stdout: fixture("vercel-env-preview.json"), stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const development = await collectPlatformEvidence({ environment: "development", target: "preview.example", expectedRef: "dev", commandRunner });
    expect(development).toMatchObject({ requested_environment: "development", environment: { target: "preview", required_missing: [] } });
    expect(commandRunner.mock.calls).toContainEqual(["vercel", ["env", "ls", "preview", "--json"], expect.any(Object)]);
    const production = await collectPlatformEvidence({ environment: "production", target: "arena.example", commandRunner });
    expect(production).toMatchObject({ requested_environment: "production", environment: { target: "production" } });
    const localRunner = vi.fn();
    await expect(collectPlatformEvidence({ environment: "local", commandRunner: localRunner })).resolves.toMatchObject({ requested_environment: "local", state: "not_applicable" });
    expect(localRunner).not.toHaveBeenCalled();
  });
});

describe("ops evidence and verdict honesty", () => {
  it("rejects a real 302 without issuing a second request or forwarding the bearer token", async () => {
    const requests = [];
    const server = createServer((request, response) => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        contentLength: request.headers["content-length"],
        transferEncoding: request.headers["transfer-encoding"],
      });
      if (request.url === "/api/health") {
        response.writeHead(302, { location: "/credential-capture" });
        response.end("redirecting");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    const port = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    try {
      const result = await requestOpsJson({ baseUrl: new URL(`http://127.0.0.1:${port}`), path: "/api/health", token: "redirect-secret", timeoutMs: 1_000, retries: 0 });
      expect(result).toMatchObject({ ok: false, status: 302, error: "redirect_rejected", kind: "redirect", attempts: 1 });
      expect(requests).toEqual([{ url: "/api/health", authorization: "Bearer redirect-secret", contentLength: undefined, transferEncoding: undefined }]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("rejects every redirect status without reading its body or retrying", async () => {
    const statuses = [300, 301, 302, 303, 307, 308, 399];
    const cancellations = [];
    const requests = statuses.map((status) => {
      const cancel = vi.fn(() => new Promise(() => {}));
      cancellations.push(cancel);
      const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status, headers: new Headers({ location: "/elsewhere" }), body: { locked: false, cancel }, json: vi.fn() });
      return requestOpsJson({ baseUrl: new URL("https://arena.example"), path: "/api/health", token: "redirect-secret", fetchImpl, timeoutMs: 25, retries: 2 });
    });
    const results = await hardBound(Promise.all(requests));
    expect(results).toEqual(statuses.map((status) => expect.objectContaining({ ok: false, status, error: "redirect_rejected", kind: "redirect", attempts: 1 })));
    expect(cancellations.every((cancel) => cancel.mock.calls.length === 1)).toBe(true);
  });

  it("bounds declared and chunked JSON responses and cancels overflow streams", async () => {
    for (const declared of [true, false]) {
      let cancelled = false;
      const payload = JSON.stringify({ data: "x".repeat(64) });
      const body = new ReadableStream({
        start(controller) { controller.enqueue(Buffer.from(payload)); },
        cancel() { cancelled = true; },
      });
      let signal;
      const fetchImpl = vi.fn(async (_url, init) => {
        signal = init.signal;
        return {
          ok: true,
          status: 200,
          headers: new Headers(declared ? { "content-length": String(Buffer.byteLength(payload)) } : {}),
          body,
          json: async () => JSON.parse(payload),
        };
      });
      await expect(requestOpsJson({ baseUrl: new URL("https://arena.example"), path: "/api/health", fetchImpl, timeoutMs: 100, retries: 0, maxResponseBytes: 16 })).resolves.toMatchObject({
        ok: false,
        status: 200,
        error: "response_too_large",
        kind: "response_too_large",
      });
      expect(cancelled).toBe(true);
      expect(signal.aborted).toBe(true);
      expect(fetchImpl).toHaveBeenCalledWith("https://arena.example/api/health", expect.objectContaining({ method: "GET", redirect: "manual" }));
    }
  });

  it("applies the request deadline while streaming and cleans up the reader", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel() { cancelled = true; },
    });
    let signal;
    const fetchImpl = vi.fn(async (_url, init) => {
      signal = init.signal;
      return { ok: true, status: 200, headers: new Headers(), body, json: async () => { throw new Error("legacy unbounded json path called"); } };
    });
    await expect(requestOpsJson({ baseUrl: new URL("https://arena.example"), path: "/api/health", fetchImpl, timeoutMs: 10, retries: 0, maxResponseBytes: 16 })).resolves.toMatchObject({ error: "request_timeout", kind: "timeout" });
    expect(cancelled).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it("fails closed on a malformed content-length before consuming JSON", async () => {
    let cancelled = false;
    const json = vi.fn(async () => ({ ok: true }));
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({ "content-length": "12, 13" }), body, json });
    await expect(requestOpsJson({ baseUrl: new URL("https://arena.example"), path: "/api/health", fetchImpl, timeoutMs: 100, retries: 0 })).resolves.toMatchObject({
      ok: false,
      status: 200,
      error: "invalid_content_length",
      kind: "invalid_content_length",
    });
    expect(cancelled).toBe(true);
    expect(json).not.toHaveBeenCalled();
  });

  it("settles within a hard bound when cancellation never settles across every cleanup path", async () => {
    const never = () => new Promise(() => {});
    const declaredCancel = vi.fn(never);
    const malformedCancel = vi.fn(never);
    const chunkedCancel = vi.fn(never);
    const timeoutCancel = vi.fn(never);
    const requests = [
      requestOpsJson({ baseUrl: new URL("https://arena.example"), path: "/api/health", fetchImpl: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({ "content-length": "99" }), body: { locked: false, cancel: declaredCancel } }), maxResponseBytes: 8, timeoutMs: 25, retries: 0 }),
      requestOpsJson({ baseUrl: new URL("https://arena.example"), path: "/api/health", fetchImpl: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({ "content-length": "0, 1" }), body: { locked: false, cancel: malformedCancel } }), maxResponseBytes: 8, timeoutMs: 25, retries: 0 }),
      requestOpsJson({ baseUrl: new URL("https://arena.example"), path: "/api/health", fetchImpl: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({ read: vi.fn().mockResolvedValue({ done: false, value: Buffer.from("too large") }), cancel: chunkedCancel, releaseLock: vi.fn() }) } }), maxResponseBytes: 2, timeoutMs: 25, retries: 0 }),
      requestOpsJson({ baseUrl: new URL("https://arena.example"), path: "/api/health", fetchImpl: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({ read: never, cancel: timeoutCancel, releaseLock: vi.fn() }) } }), maxResponseBytes: 8, timeoutMs: 10, retries: 0 }),
    ];
    const results = await hardBound(Promise.all(requests));
    expect(results).toEqual([
      expect.objectContaining({ error: "response_too_large" }),
      expect.objectContaining({ error: "invalid_content_length" }),
      expect.objectContaining({ error: "response_too_large" }),
      expect.objectContaining({ error: "request_timeout" }),
    ]);
    expect([declaredCancel, malformedCancel, chunkedCancel, timeoutCancel].every((cancel) => cancel.mock.calls.length === 1)).toBe(true);
  });

  it("absorbs thrown cancellation rejections without changing the bounded result", async () => {
    const cancel = vi.fn(() => Promise.reject(new Error("hostile cancel rejection")));
    const result = await requestOpsJson({
      baseUrl: new URL("https://arena.example"),
      path: "/api/health",
      fetchImpl: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({ "content-length": "99" }), body: { locked: false, cancel } }),
      maxResponseBytes: 8,
      timeoutMs: 25,
      retries: 0,
    });
    expect(result).toMatchObject({ error: "response_too_large" });
    expect(cancel).toHaveBeenCalledOnce();
    await delay(0);
  });

  it("fails closed without calling response.json when no readable stream is available", async () => {
    const json = vi.fn(async () => ({ secret: "post-hoc" }));
    let signal;
    const fetchImpl = vi.fn(async (_url, init) => {
      signal = init.signal;
      return { ok: true, status: 200, headers: new Headers({ "content-length": "2" }), body: null, json };
    });
    await expect(requestOpsJson({ baseUrl: new URL("https://arena.example"), path: "/api/health", fetchImpl, timeoutMs: 25, retries: 0 })).resolves.toMatchObject({
      ok: false,
      error: "response_stream_unavailable",
      kind: "response_stream_unavailable",
    });
    expect(json).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(true);
  });

  it("treats a syntactically valid zero content-length as bounded malformed JSON", async () => {
    const response = new Response("", { status: 200, headers: { "content-length": "0" } });
    await expect(requestOpsJson({ baseUrl: new URL("https://arena.example"), path: "/api/health", fetchImpl: vi.fn().mockResolvedValue(response), timeoutMs: 25, retries: 0 })).resolves.toMatchObject({ error: "invalid_json" });
  });

  it("aggregates every advertised inventory and correlates bounded run/event evidence", async () => {
    const fetchImpl = healthyApiFetch();
    const result = await collectAgentOpsStatus({ baseUrl: "https://arena.example", token: "not-for-output", fetchImpl, now: "2026-08-03T00:10:00.000Z", platform: healthyPlatform, environment: "production" });
    expect(result).toMatchObject({ schema_version: "agent_ops_status.v1", verdict: "healthy", exit_code: EXIT_CODES.healthy, ops: { inventory: { runs: { records: 2, pages: 2, complete: true }, events: { records: 2 }, competitions: { records: 1 } }, runs: expect.arrayContaining([expect.objectContaining({ run_id: "r1", state: "running", sandbox_id: "sbx-1", callback: "delivered", cost_usd: 1.25, tasks: { total: 2, passed: 1 }, provider: "vercel-ai-gateway", latest_event: expect.objectContaining({ seq: 2, type: "task.completed", action: "judge" }) })]) } });
    expect(fetchImpl.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("not-for-output");
  });

  it("classifies false health, partial pagination, and unknown freshness honestly", async () => {
    const failed = await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: healthyApiFetch({ healthOk: false }), now: "2026-08-03T00:10:00.000Z", platform: healthyPlatform, environment: "production" });
    expect(failed).toMatchObject({ verdict: "failed", exit_code: EXIT_CODES.failed });
    const partial = await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: healthyApiFetch({ missingCursor: true }), now: "2026-08-03T00:10:00.000Z", platform: healthyPlatform, environment: "production" });
    expect(partial).toMatchObject({ verdict: "degraded", exit_code: EXIT_CODES.degraded, ops: { inventory: { runs: { complete: false, error: "missing_cursor" } } } });
    const unknown = await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: healthyApiFetch({ unknownFreshness: true }), now: "2026-08-03T00:10:00.000Z", platform: healthyPlatform, environment: "production" });
    expect(unknown).toMatchObject({ verdict: "degraded", exit_code: EXIT_CODES.degraded, freshness: { state: "unknown" } });
  });

  it("separates access blockers, transient failures, invalid JSON, and bounded retries", async () => {
    expect((await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401)), platform: healthyPlatform })).verdict).toBe("access_blocked");
    expect((await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: vi.fn().mockRejectedValue(new Error("socket failed token=leak")), platform: healthyPlatform })).verdict).toBe("failed");
    const invalidJson = vi.fn().mockResolvedValue(new Response("{", { status: 200, headers: { "content-type": "application/json" } }));
    expect((await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: invalidJson, platform: healthyPlatform })).verdict).toBe("failed");
    const transient = vi.fn().mockResolvedValueOnce(jsonResponse({ error: "busy" }, 503)).mockResolvedValueOnce(jsonResponse({ ok: true }, 200));
    expect(await requestOpsJson({ baseUrl: new URL("https://arena.example"), path: "/api/health", fetchImpl: transient, timeoutMs: 100, retries: 1 })).toMatchObject({ ok: true, attempts: 2 });
  });

  it("surfaces dirty/non-main/SHA drift, logs, missing env, cron, provider, and capability evidence", async () => {
    const platform = { ...healthyPlatform, expected_sha: "expected", deployment: { ...healthyPlatform.deployment, sha: "served", ref: "feature", git_dirty: true }, environment: { records: [], required_missing: ["OPS_READ_TOKEN"] }, logs: { recent_errors: [{ level: "error", status_code: 500, message: "boom" }] }, cron: { state: "unknown" } };
    const fetchImpl = healthyApiFetch();
    const result = await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl, now: "2026-08-03T00:10:00.000Z", platform, environment: "production" });
    expect(result.verdict).toBe("failed");
    expect(result.findings.map(({ code }) => code)).toEqual(expect.arrayContaining(["deployment_sha_drift", "deployment_ref_drift", "deployment_git_dirty", "required_environment_missing", "recent_runtime_errors", "cron_unknown"]));
    expect(result.ops.capabilities).toMatchObject({ gateway: "present", callback: "present" });
  });

  it("requires a READY serving deployment with identity even when SHA and ref match", async () => {
    for (const deployment of [
      { ...healthyPlatform.deployment, state: "ERROR" },
      { ...healthyPlatform.deployment, state: "FAILED" },
      { ...healthyPlatform.deployment, state: "CANCELED" },
      { ...healthyPlatform.deployment, state: null },
      { ...healthyPlatform.deployment, id: null },
      { ...healthyPlatform.deployment, hostname: null },
      { ...healthyPlatform.deployment, sha: null },
      { ...healthyPlatform.deployment, ref: null },
    ]) {
      const result = await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: healthyApiFetch(), now: "2026-08-03T00:10:00.000Z", platform: { ...healthyPlatform, deployment }, environment: "production" });
      expect(result).toMatchObject({ verdict: "failed", exit_code: EXIT_CODES.failed });
      expect(result.findings.map(({ code }) => code)).toEqual(expect.arrayContaining([expect.stringMatching(/^deployment_(?:not_ready|lineage_missing)$/)]));
    }
  });

  it("treats malformed pagination and advertised-kind/run caps as explicit degraded scope", async () => {
    const malformed = await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: healthyApiFetch({ missingHasMore: true }), now: "2026-08-03T00:10:00.000Z", platform: healthyPlatform, environment: "production" });
    expect(malformed).toMatchObject({ verdict: "degraded", exit_code: EXIT_CODES.degraded, ops: { inventory: { runs: { complete: false, error: "malformed_pagination" } } } });

    const kindNames = ["runs", "events", ..."abcdefghijklmnopqrs"].map((kind) => ({ kind }));
    const kinds = await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: healthyApiFetch({ advertisedKinds: kindNames }), now: "2026-08-03T00:10:00.000Z", platform: healthyPlatform, environment: "production" });
    expect(kinds).toMatchObject({ verdict: "degraded", ops: { inventory_scope: { advertised: 21, selected: 20, truncated: true } } });
    expect(kinds.findings.map(({ code }) => code)).toContain("inventory_kind_limit");

    const runs = await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: healthyApiFetch({ runCount: 21 }), now: "2026-08-03T00:10:00.000Z", platform: healthyPlatform, environment: "production" });
    expect(runs).toMatchObject({ verdict: "degraded", ops: { run_correlation_scope: { available: 21, selected: 20, truncated: true } } });
    expect(runs.findings.map(({ code }) => code)).toContain("run_correlation_limit");

    const pageOverflow = await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: healthyApiFetch({ runCount: 101 }), now: "2026-08-03T00:10:00.000Z", platform: healthyPlatform, environment: "production" });
    expect(pageOverflow).toMatchObject({ verdict: "degraded", ops: { inventory: { runs: { records: 0, pages: 0, complete: false, error: "page_item_limit" } } } });
    const serverPageOverflow = await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: healthyApiFetch({ serverPageLimit: true }), now: "2026-08-03T00:10:00.000Z", platform: healthyPlatform, environment: "production" });
    expect(serverPageOverflow).toMatchObject({ verdict: "degraded", ops: { inventory: { runs: { complete: false, error: "page_item_limit" } } } });
  });

  it("classifies unreadable, corrupt, and event-hole integrity evidence as failed", async () => {
    for (const integrity of [{ unreadable: 1, corrupt: 0, event_holes: 0 }, { unreadable: 0, corrupt: 1, event_holes: 0 }, { unreadable: 0, corrupt: 0, event_holes: 1 }]) {
      const result = await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: healthyApiFetch({ integrity }), now: "2026-08-03T00:10:00.000Z", platform: healthyPlatform, environment: "production" });
      expect(result).toMatchObject({ verdict: "failed", exit_code: EXIT_CODES.failed });
      expect(result.findings).toContainEqual(expect.objectContaining({ code: "ops_integrity", severity: "failed" }));
    }
  });

  it("turns malformed ops-root kinds into operational evidence, never usage exit 64", async () => {
    for (const advertisedKinds of [{ runs: true }, [{ kind: "runs" }, { kind: "BAD!" }]]) {
      const writes = [];
      const exit = await executeCli(["--env", "local", "--json"], { fetchImpl: healthyApiFetch({ advertisedKinds }), env: {}, writeOut: (value) => writes.push(value), writeErr: (value) => writes.push(value), now: "2026-08-03T00:10:00.000Z" });
      expect(exit).toBe(EXIT_CODES.failed);
      expect(JSON.parse(writes[0])).toMatchObject({ verdict: "failed", findings: expect.arrayContaining([expect.objectContaining({ code: "ops_root_contract" })]) });
    }
  });

  it("reserves exit 64 for argv misuse rather than invalid environment configuration", async () => {
    const writes = [];
    expect(await executeCli(["--env", "local", "--json"], { env: { HARNESS_ARENA_LOCAL_URL: "not a URL" }, writeOut: (value) => writes.push(value), writeErr: (value) => writes.push(value) })).toBe(EXIT_CODES.failed);
    expect(JSON.parse(writes[0])).toMatchObject({ verdict: "failed", findings: expect.arrayContaining([expect.objectContaining({ code: "environment_configuration" })]) });
    expect(await executeCli(["--env", "bogus"], { env: {}, writeOut: vi.fn(), writeErr: vi.fn() })).toBe(EXIT_CODES.usage_error);
  });

  it("reports malformed run inventory records instead of silently dropping them", async () => {
    const records = [{ pathname: "runs/r1.json", uploaded_at: "2026-08-03T00:05:00.000Z" }, { pathname: "runs/../../hidden.json", uploaded_at: "2026-08-03T00:04:00.000Z" }];
    const result = await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: healthyApiFetch({ runRecords: records }), now: "2026-08-03T00:10:00.000Z", platform: healthyPlatform, environment: "production" });
    expect(result).toMatchObject({ verdict: "failed", ops: { run_correlation_scope: { available: 2, valid: 1, selected: 1, invalid: 1, truncated: false } } });
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "run_inventory_record_invalid" }));
  });

  it("requires an explicit null next_cursor on a terminal inventory page", async () => {
    const result = await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: healthyApiFetch({ missingTerminalCursor: true }), now: "2026-08-03T00:10:00.000Z", platform: healthyPlatform, environment: "production" });
    expect(result).toMatchObject({ verdict: "degraded", ops: { inventory: { runs: { complete: false, error: "malformed_pagination" } } } });
  });
});

describe("redaction, platform wiring, and process bounds", () => {
  it("recursively redacts headers, sensitive fields, URLs, arbitrary errors, and supplied literals", () => {
    const value = { Authorization: "Basic dXNlcjpwYXNz", Cookie: "sid=secret", "Set-Cookie": "sid=secret", "x-api-key": "key", nested: [{ password: "pw", detail: "failed with Bearer abc and literal-needle at https://x.test/a?token=literal-needle" }] };
    const output = JSON.stringify(redactSensitive(value, ["literal-needle", "secret"]));
    for (const leaked of ["dXNlcjpwYXNz", "sid=secret", "literal-needle", "Bearer abc", "https://x.test/a?token="]) expect(output).not.toContain(leaked);
  });

  it("redacts credential-shaped keys and complete semicolon-delimited cookie headers recursively", () => {
    const value = {
      payload: [{ client_secret: "alpha", access_token: "beta", refresh_token: "csrf", apiKey: "alpha" }],
      error: "upstream failed access_token=beta client_secret=alpha",
      headers: ["Cookie: alpha=one; beta=two; csrf=three", "Set-Cookie: alpha=one; beta=two; csrf=three; Secure"],
    };
    const output = JSON.stringify(redactSensitive(value, ["alpha", "beta", "csrf"]));
    for (const leaked of ["alpha", "beta", "csrf", "one", "two", "three", "access_token=beta", "client_secret=alpha"]) expect(output).not.toContain(leaked);
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("redacts quoted and camel-case credentials inside nested JSON strings and Error causes", () => {
    const cause = new Error('cause={"access_token":"cause-access","clientSecret":"cause-client"}');
    cause.context = { serialized: '{"refresh_token":"cause-refresh"}' };
    const error = new Error('upstream={"access_token":"error-access","refresh_token":"error-refresh","clientSecret":"error-client"}', { cause });
    const value = {
      error,
      nested: [
        '{"access_token":"nested-access","refresh_token":"nested-refresh","clientSecret":"nested-client"}',
        "clientSecret='single-client' access_token=bare-access",
      ],
    };
    const output = JSON.stringify(redactSensitive(value));
    for (const leaked of ["cause-access", "cause-client", "cause-refresh", "error-access", "error-refresh", "error-client", "nested-access", "nested-refresh", "nested-client", "single-client", "bare-access"]) expect(output).not.toContain(leaked);
    expect(output).toContain('"name":"Error"');
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(8);
  });

  it("strips URL userinfo and redacts quoted cookie and header variants in hostile strings", () => {
    const error = new Error('upstream={"cookie":"error-cookie","setCookie":"error-set","proxyAuthorization":"error-proxy"} at https://error-user:error-pass@x.test/a?token=q#fragment');
    const output = JSON.stringify(redactSensitive({
      error,
      urls: ["https://user:pass@x.test/a?token=q#fragment", "https://us%65r:p%40ss@x.test/b?sig=signed#secret"],
      nested: [
        '{"cookie":"nested-cookie","setCookie":"nested-set","set-cookie":"nested-dash","Cookie":"upper-cookie","cookieHeader":"header-cookie"}',
        "Cookie: sid=one; csrf=two",
        "set_cookie='snake-cookie' xApiKey='header-key'",
      ],
    }));
    for (const leaked of ["user", "pass", "us%65r", "p%40ss", "error-user", "error-pass", "error-cookie", "error-set", "error-proxy", "nested-cookie", "nested-set", "nested-dash", "upper-cookie", "header-cookie", "sid=one", "csrf=two", "snake-cookie", "header-key", "token=q", "sig=signed", "fragment"]) expect(output).not.toContain(leaked);
    expect(output).toContain("[REDACTED]");
  });

  it("wires the production CLI through injected Vercel/GitHub commands and emits JSON or human output", async () => {
    const commandRunner = vi.fn(async (binary, args) => {
      if (binary === "gh") return { stdout: fixture("github-sha.txt"), stderr: "", exitCode: 0 };
      if (args[0] === "ls") return { stdout: fixture("vercel-list.json"), stderr: "", exitCode: 0 };
      if (args[0] === "inspect") return { stdout: fixture("vercel-inspect.json"), stderr: "", exitCode: 0 };
      if (args[0] === "env") return { stdout: fixture("vercel-env.json"), stderr: "", exitCode: 0 };
      return { stdout: fixture("vercel-logs.ndjson"), stderr: "", exitCode: 0 };
    });
    const writes = [];
    const jsonRun = await executeCli(["--env", "production", "--json"], { commandRunner, fetchImpl: healthyApiFetch(), env: { OPS_READ_TOKEN: "literal-secret", HARNESS_ARENA_PRODUCTION_URL: "https://arena.example" }, writeOut: (value) => writes.push(value), writeErr: (value) => writes.push(value), now: "2026-08-03T00:10:00.000Z" });
    expect(commandRunner.mock.calls.map(([binary]) => binary)).toEqual(expect.arrayContaining(["vercel", "gh"]));
    expect(JSON.parse(writes[0])).toMatchObject({ schema_version: "agent_ops_status.v1" });
    expect(writes.join("\n")).not.toContain("literal-secret");
    expect(jsonRun).toBe(EXIT_CODES.failed);
    writes.length = 0;
    await executeCli(["--env", "local"], { commandRunner, fetchImpl: healthyApiFetch(), env: {}, writeOut: (value) => writes.push(value), writeErr: (value) => writes.push(value), now: "2026-08-03T00:10:00.000Z" });
    expect(writes[0]).toContain("STATUS:");
  });

  it("turns command-not-found and timeout into explicit platform access blockers", async () => {
    for (const code of ["ENOENT", "command_timeout"]) {
      const commandRunner = vi.fn().mockRejectedValue(Object.assign(new Error(code), { code }));
      const result = await collectPlatformEvidence({ environment: "production", commandRunner });
      expect(result).toMatchObject({ state: "access_blocked", blockers: expect.arrayContaining([expect.objectContaining({ code: expect.stringContaining("command") })]) });
    }
  });

  it("caps subprocess output and escalates SIGTERM to bounded SIGKILL", async () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn((signal) => { if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, signal)); return true; });
    const pending = spawnCommand("vercel", ["ls"], { spawnImpl: () => child, timeoutMs: 1, killGraceMs: 1, maxBufferBytes: 8 });
    child.stdout.write("0123456789");
    await expect(pending).rejects.toThrow(/command_(?:output_limit|timeout)/);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("bounds a silent subprocess timeout through SIGTERM and SIGKILL", async () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn((signal) => { if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, signal)); return true; });
    await expect(spawnCommand("vercel", ["ls"], { spawnImpl: () => child, timeoutMs: 1, killGraceMs: 1 })).rejects.toThrow("command_timeout");
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("keeps human output concise and names contradictory evidence", () => {
    const output = formatHumanStatus({ verdict: "degraded", exit_code: EXIT_CODES.degraded, findings: [{ code: "contradictory_evidence", detail: "Basic abc" }], blockers: [], freshness: { state: "unknown" }, ops: { inventory: {} } });
    expect(output).toContain("STATUS: DEGRADED"); expect(output).toContain("contradictory_evidence"); expect(output).not.toContain("abc");
  });
});
