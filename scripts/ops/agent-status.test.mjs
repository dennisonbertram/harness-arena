import { describe, expect, it, vi } from "vitest";
import {
  EXIT_CODES,
  collectAgentOpsStatus,
  createVercelCommandAdapter,
  formatHumanStatus,
  redactSensitive,
} from "./agent-status.mjs";

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function fetchSequence(items) {
  const fetchImpl = vi.fn();
  for (const item of items) fetchImpl.mockResolvedValueOnce(response(item.body, item.status));
  return fetchImpl;
}

describe("agent ops status", () => {
  it("collects a bounded GET-only health, summary, and paginated inventory snapshot", async () => {
    const fetchImpl = fetchSequence([
      { body: { ok: true, sha: "abc123", storage: "up" } },
      { body: { schema_version: "ops.v1", inventory: "/api/ops/v1/inventory", summary: "/api/ops/v1/summary" } },
      { body: { schema_version: "ops.v1", scan: { complete: true }, latest: { runs: "2026-08-03T00:00:00.000Z" }, run_states: { stale: 0 }, integrity: { unreadable: 0, corrupt: 0, event_holes: 0 } } },
      { body: { schema_version: "ops.v1", kind: "runs", items: [{ pathname: "runs/a.json" }], has_more: true, next_cursor: "page-2" } },
      { body: { schema_version: "ops.v1", kind: "runs", items: [{ pathname: "runs/b.json" }], has_more: false, next_cursor: null } },
    ]);

    const result = await collectAgentOpsStatus({ baseUrl: "https://arena.example", token: "not-for-output", fetchImpl, now: "2026-08-03T00:05:00.000Z" });

    expect(result).toMatchObject({ schema_version: "agent_ops_status.v1", verdict: "healthy", exit_code: EXIT_CODES.healthy, ops: { inventory: { runs: { records: 2, pages: 2, complete: true } } } });
    expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), init.method])).toEqual([
      ["https://arena.example/api/health", "GET"],
      ["https://arena.example/api/ops/v1", "GET"],
      ["https://arena.example/api/ops/v1/summary", "GET"],
      ["https://arena.example/api/ops/v1/inventory?kind=runs&limit=100", "GET"],
      ["https://arena.example/api/ops/v1/inventory?kind=runs&limit=100&cursor=page-2", "GET"],
    ]);
  });

  it("reports authorization and pagination limits as access blockers without leaking the token", async () => {
    const fetchImpl = fetchSequence([{ body: { error: "unauthorized", token: "not-for-output" }, status: 401 }]);
    const result = await collectAgentOpsStatus({ baseUrl: "https://arena.example", token: "not-for-output", fetchImpl });

    expect(result).toMatchObject({ verdict: "access_blocked", exit_code: EXIT_CODES.access_blocked, blockers: [expect.objectContaining({ code: "health_access" })] });
    expect(JSON.stringify(result)).not.toContain("not-for-output");
  });

  it("flags stale, incomplete, and deployment SHA drift as actionable", async () => {
    const fetchImpl = fetchSequence([
      { body: { ok: true, sha: "app-sha", storage: "degraded" } },
      { body: { schema_version: "ops.v1", inventory: "/api/ops/v1/inventory", summary: "/api/ops/v1/summary" } },
      { body: { schema_version: "ops.v1", scan: { complete: false, truncated: true }, latest: { runs: "2026-08-02T20:00:00.000Z" }, run_states: { stale: 1 }, integrity: { unreadable: 1, corrupt: 0, event_holes: 0 } } },
      { body: { schema_version: "ops.v1", kind: "runs", items: [], has_more: false, next_cursor: null } },
    ]);
    const result = await collectAgentOpsStatus({ baseUrl: "https://arena.example", token: "t", fetchImpl, now: "2026-08-03T00:00:00.000Z", vercel: { deployment: { sha: "other-sha", readyState: "READY" } } });

    expect(result).toMatchObject({ verdict: "action_required", exit_code: EXIT_CODES.action_required });
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["storage_degraded", "summary_incomplete", "stale_runs", "deployment_sha_drift", "freshness_stale"]));
  });

  it("redacts sensitive values and constrains injected Vercel commands to safe read-only subcommands", async () => {
    expect(redactSensitive({ authorization: "Bearer top-secret", url: "https://x.test/path?token=top-secret", nested: "top-secret" }, ["top-secret"])).toEqual({ authorization: "[REDACTED]", url: "https://x.test/path", nested: "[REDACTED]" });
    const run = vi.fn().mockResolvedValue({ stdout: '{"deployments":[]}', stderr: "", exitCode: 0 });
    const adapter = createVercelCommandAdapter(run);
    await expect(adapter.run(["ls", "--json"])).resolves.toEqual({ stdout: '{"deployments":[]}', stderr: "", exitCode: 0 });
    await expect(adapter.run(["rm", "anything"])).rejects.toThrow("unsafe_vercel_command");
    expect(run).toHaveBeenCalledWith("vercel", ["ls", "--json"], { timeoutMs: 10_000 });
  });

  it("keeps human output concise and redacted", () => {
    const output = formatHumanStatus({ schema_version: "agent_ops_status.v1", verdict: "access_blocked", exit_code: 3, findings: [], blockers: [{ code: "ops_unauthorized", detail: "Bearer secret" }], freshness: { state: "unknown" } });
    expect(output).toContain("ACCESS BLOCKED");
    expect(output).not.toContain("secret");
  });
});
