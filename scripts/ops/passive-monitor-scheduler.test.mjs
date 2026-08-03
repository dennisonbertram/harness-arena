import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const config = JSON.parse(readFileSync(new URL("vercel.json", root), "utf8"));
const runbook = readFileSync(new URL("docs/runbooks/passive-agent-monitoring.md", root), "utf8");

describe("read-only Development Vercel Cron scheduler", () => {
  it("removes the abandoned GitHub writer while retaining daily reap and monitor backstops", () => {
    expect(existsSync(new URL(".github/workflows/passive-agent-monitor.yml", root))).toBe(false);
    expect(existsSync(new URL("scripts/ops/apply-passive-monitor-plan.mjs", root))).toBe(false);
    expect(existsSync(new URL("scripts/ops/passive-monitor.mjs", root))).toBe(false);
    expect(config.crons).toEqual([
      { path: "/api/cron/reap", schedule: "0 3 * * *" },
      { path: "/api/cron/agent-monitor", schedule: "17 3 * * *" },
    ]);
  });

  it("documents fixed targets, read-only credentials, retained evidence, and rollback", () => {
    expect(runbook).toMatch(/prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA/);
    expect(runbook).toMatch(/https:\/\/harness-arena-development\.vercel\.app/);
    expect(runbook).toMatch(/https:\/\/harness-arena-psi\.vercel\.app/);
    expect(runbook).toMatch(/DEVELOPMENT_OPS_READ_TOKEN/);
    expect(runbook).toMatch(/PRODUCTION_OPS_READ_TOKEN/);
    expect(runbook).toMatch(/access_blocked/);
    expect(runbook).toMatch(/monitor\.observation/);
    expect(runbook).toMatch(/once[- ]daily/i);
    expect(runbook).toMatch(/\/api\/cron\/reap/);
    expect(runbook).toMatch(/OpenTelemetry|trace/i);
    expect(runbook).toMatch(/rollback/i);
    expect(runbook).not.toMatch(/GitHub token|issue (?:create|write|reopen|close)|workflow_dispatch/i);
  });
});
