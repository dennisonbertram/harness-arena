import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
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
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function healthyApiFetch({ missingCursor = false, missingHasMore = false, unknownFreshness = false, healthOk = true, advertisedKinds, runCount, integrity } = {}) {
  return vi.fn(async (rawUrl, init) => {
    expect(init.method).toBe("GET");
    const url = new URL(rawUrl);
    if (url.pathname === "/api/health") return jsonResponse({ ok: healthOk, sha: "abc123", storage: "up", gateway_key_present: true, runner_secret_present: true });
    if (url.pathname === "/api/ops/v1") return jsonResponse({ schema_version: "ops.v1", kinds: advertisedKinds ?? [{ kind: "runs" }, { kind: "events" }, { kind: "competitions" }], inventory: "/api/ops/v1/inventory", read: "/api/ops/v1/read", summary: "/api/ops/v1/summary" });
    if (url.pathname === "/api/ops/v1/summary") return jsonResponse({ schema_version: "ops.v1", scan: { complete: true }, latest: { runs: unknownFreshness ? null : "2026-08-03T00:05:00.000Z", events: "2026-08-03T00:06:00.000Z" }, run_states: { queued: 0, running: 1, failed: 0, stale: 0 }, integrity: integrity ?? { unreadable: 0, corrupt: 0, event_holes: 0 } });
    if (url.pathname === "/api/ops/v1/inventory") {
      const kind = url.searchParams.get("kind"), cursor = url.searchParams.get("cursor");
      if (kind === "runs" && runCount) return jsonResponse({ schema_version: "ops.v1", kind, items: Array.from({ length: runCount }, (_, index) => ({ pathname: `runs/r${index + 1}.json`, uploaded_at: "2026-08-03T00:05:00.000Z" })), has_more: false, next_cursor: null });
      if (kind === "runs" && !cursor) return jsonResponse({ schema_version: "ops.v1", kind, items: [{ pathname: "runs/r1.json", uploaded_at: "2026-08-03T00:05:00.000Z" }], ...(missingHasMore ? {} : { has_more: true }), next_cursor: missingCursor ? null : "runs-2" });
      if (kind === "runs") return jsonResponse({ schema_version: "ops.v1", kind, items: [{ pathname: "runs/r2.json", uploaded_at: "2026-08-03T00:04:00.000Z" }], has_more: false, next_cursor: null });
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
});

describe("ops evidence and verdict honesty", () => {
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
    const invalidJson = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } });
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
    ]) {
      const result = await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: healthyApiFetch(), now: "2026-08-03T00:10:00.000Z", platform: { ...healthyPlatform, deployment }, environment: "production" });
      expect(result).toMatchObject({ verdict: "failed", exit_code: EXIT_CODES.failed });
      expect(result.findings.map(({ code }) => code)).toContain("deployment_not_ready");
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
  });

  it("classifies unreadable, corrupt, and event-hole integrity evidence as failed", async () => {
    for (const integrity of [{ unreadable: 1, corrupt: 0, event_holes: 0 }, { unreadable: 0, corrupt: 1, event_holes: 0 }, { unreadable: 0, corrupt: 0, event_holes: 1 }]) {
      const result = await collectAgentOpsStatus({ baseUrl: "https://arena.example", fetchImpl: healthyApiFetch({ integrity }), now: "2026-08-03T00:10:00.000Z", platform: healthyPlatform, environment: "production" });
      expect(result).toMatchObject({ verdict: "failed", exit_code: EXIT_CODES.failed });
      expect(result.findings).toContainEqual(expect.objectContaining({ code: "ops_integrity", severity: "failed" }));
    }
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
    for (const leaked of ["alpha", "beta", "csrf", "one", "two", "three", "access_token=", "client_secret="]) expect(output).not.toContain(leaked);
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(6);
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
