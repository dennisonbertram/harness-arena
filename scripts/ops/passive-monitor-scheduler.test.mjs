import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
const runbook = readFileSync(new URL("../../docs/runbooks/passive-agent-monitoring.md", import.meta.url), "utf8");

describe("direct Development Vercel Cron scheduler", () => {
  it("removes the GitHub workflow and schedules only the project-pinned GET route", () => {
    expect(existsSync(new URL("../../.github/workflows/passive-agent-monitor.yml", import.meta.url))).toBe(false);
    expect(config.crons).toEqual([{ path: "/api/cron/agent-monitor", schedule: "17,47 * * * *" }]);
  });

  it("documents provisioning and strict authority boundaries", () => {
    expect(runbook).toMatch(/Development project[^\n]*prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA/i);
    expect(runbook).toMatch(/required provisioned repository label[^\n]*`agent-monitor`/i);
    expect(runbook).toMatch(/GITHUB_MONITOR_ISSUES_TOKEN[^\n]*infrastructure automation only/i);
    expect(runbook).toMatch(/DEVELOPMENT_OPS_READ_TOKEN/);
    expect(runbook).toMatch(/PRODUCTION_OPS_READ_TOKEN/);
    expect(runbook).toMatch(/production[^\n]*(?:access_blocked|degraded)/i);
    expect(runbook).not.toMatch(/workflow_dispatch|GitHub Actions schedule/i);
  });
});
