import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildObservation,
  executeMonitor,
  issueBodyForAction,
  planIncidentTransitions,
  sanitizeMonitorRecord,
  stableFingerprint,
} from "./passive-monitor.mjs";

const healthy = { schema_version: "agent_ops_status.v1", environment: "development", verdict: "healthy", exit_code: 0, checked_at: "2026-08-03T12:00:00.000Z", health: { sha: "abcdef1" }, platform: { deployment: { id: "dpl_1", sha: "abcdef1" } }, findings: [], blockers: [] };
const failed = (codes, sha = "abcdef1") => ({ ...healthy, verdict: "failed", exit_code: 2, health: { sha }, platform: { deployment: { id: "dpl_1", sha } }, findings: codes.map((code) => ({ code, severity: "failed", detail: `secret=monitor-token prompt=private request ${code}` })) });
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

function runApplier(plans) {
  const directory = mkdtempSync(join(tmpdir(), "ha-monitor-applier-"));
  const log = join(directory, "argv.jsonl");
  const binary = join(directory, "gh");
  writeFileSync(binary, `#!/usr/bin/env node\nconst fs=require("node:fs");const input=fs.readFileSync(0,"utf8");fs.appendFileSync(process.env.GH_ARGV_LOG,JSON.stringify({argv:process.argv.slice(2),input})+"\\n");`);
  chmodSync(binary, 0o700);
  const files = plans.map((plan, index) => { const path = join(directory, `plan-${index}.json`); writeFileSync(path, JSON.stringify(plan)); return path; });
  const result = spawnSync(process.execPath, [new URL("./apply-passive-monitor-plan.mjs", import.meta.url).pathname, ...files], { encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, GH_ARGV_LOG: log } });
  return { result, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

describe("passive monitor incident state machine", () => {
  it("creates one stable, secret-safe incident for a new product failure", () => {
    const observation = buildObservation(failed(["storage_down"]), { environment: "development", knownSecrets: ["monitor-token"] });
    expect(observation.kind).toBe("product_failure");
    expect(observation.failures).toHaveLength(1);
    expect(observation.failures[0]).toMatchObject({ alert_class: "storage", code: "storage_down" });
    expect(JSON.stringify(observation)).not.toMatch(/monitor-token|private request/);
    expect(planIncidentTransitions({ observation, incidents: [] }).actions).toEqual([expect.objectContaining({ action: "create", fingerprint: expect.stringMatching(/^ha-monitor-v1-/) })]);
  });

  it("deduplicates repeats, comments changed deployment evidence, and handles partial then full proven recovery", () => {
    const one = buildObservation(failed(["storage_down", "freshness_stale"]), { environment: "development" });
    const storage = one.failures.find((item) => item.code === "storage_down");
    const stale = one.failures.find((item) => item.code === "freshness_stale");
    const incidents = [
      { number: 41, state: "OPEN", body: `<!-- harness-arena-monitor:${JSON.stringify({ fingerprint: storage.fingerprint, evidence_sha: "abcdef1" })} -->` },
      { number: 42, state: "OPEN", fingerprint: stale.fingerprint, evidence_sha: "abcdef1" },
    ];
    expect(planIncidentTransitions({ observation: one, incidents }).actions).toEqual([]);

    const changedDeployment = buildObservation(failed(["storage_down"], "fedcba2"), { environment: "development" });
    expect(planIncidentTransitions({ observation: changedDeployment, incidents }).actions).toEqual([
      expect.objectContaining({ action: "comment", number: 41, reason: "deployment_changed" }),
      expect.objectContaining({ action: "comment", number: 42, reason: "recovery_pending" }),
    ]);

    const partial = planIncidentTransitions({ observation: changedDeployment, incidents: [{ number: 41, state: "OPEN", fingerprint: storage.fingerprint, evidence_sha: "fedcba2" }, { ...incidents[1], recovery_pending: true }] });
    expect(partial.actions).toEqual([expect.objectContaining({ action: "close", number: 42, reason: "recovery_proven" })]);
    const full = planIncidentTransitions({ observation: buildObservation(healthy, { environment: "development" }), incidents: [{ number: 41, state: "OPEN", fingerprint: storage.fingerprint, evidence_sha: "fedcba2" }, { number: 42, state: "CLOSED", fingerprint: stale.fingerprint, recovery_pending: true }] });
    expect(full.actions).toEqual([expect.objectContaining({ action: "comment", number: 41, reason: "recovery_pending" })]);
  });

  it("reopens the exact prior incident when a recovered failure flaps", () => {
    const observation = buildObservation(failed(["gateway_capability_missing"]), { environment: "development" });
    expect(planIncidentTransitions({ observation, incidents: [{ number: 73, state: "CLOSED", fingerprint: observation.failures[0].fingerprint }] }).actions).toEqual([
      expect.objectContaining({ action: "reopen", number: 73, reason: "flap" }),
    ]);
  });

  it("keeps monitor self-failure distinct from a product failure and has stable fingerprints", () => {
    const monitorFailure = buildObservation(null, { environment: "production", monitorError: new Error("token=monitor-token prompt=private") , knownSecrets: ["monitor-token"] });
    expect(monitorFailure).toMatchObject({ kind: "monitor_self_failure", failures: [expect.objectContaining({ alert_class: "monitor", code: "monitor_execution_failed" })] });
    expect(JSON.stringify(monitorFailure)).not.toMatch(/monitor-token|private/);
    expect(stableFingerprint({ environment: "production", alert_class: "monitor", code: "monitor_execution_failed" })).toBe(monitorFailure.failures[0].fingerprint);
  });

  it("rejects malformed collector schema, verdict/exit disagreement, and nonhealthy output without evidence", () => {
    const invalid = [
      null,
      {},
      { ...healthy, schema_version: "wrong.v1" },
      { ...healthy, exit_code: 2 },
      { ...healthy, verdict: "failed", exit_code: 2, findings: [], blockers: [] },
      { ...healthy, verdict: "degraded", exit_code: 1, findings: [], blockers: [] },
    ];
    for (const status of invalid) {
      const observation = buildObservation(status, { environment: "development" });
      expect(observation).toMatchObject({ kind: "monitor_self_failure", failures: [expect.objectContaining({ alert_class: "monitor", code: "collector_output_invalid" })] });
      const pending = { number: 99, state: "OPEN", fingerprint: "prior-product-failure", recovery_pending: true };
      expect(planIncidentTransitions({ observation, incidents: [pending] }).actions).not.toContainEqual(expect.objectContaining({ action: "close", number: 99 }));
    }
  });

  it("turns banner-contaminated collector output into monitor self-failure without recovery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ha-monitor-collector-"));
    const incidents = join(directory, "incidents.json"), output = join(directory, "plan.json"), malformed = join(directory, "status.json");
    writeFileSync(incidents, JSON.stringify([{ number: 99, state: "OPEN", fingerprint: "prior-product-failure", recovery_pending: true }]));
    writeFileSync(malformed, `> harness-arena@0.1.0 ops:status\n${JSON.stringify(healthy)}`);
    expect(await executeMonitor(["--environment", "development", "--status", malformed, "--incidents", incidents, "--output", output])).toBe(2);
    const plan = JSON.parse(readFileSync(output, "utf8"));
    expect(plan.observation).toMatchObject({ environment: "development", kind: "monitor_self_failure" });
    expect(plan.actions).not.toContainEqual(expect.objectContaining({ action: "close", number: 99 }));
  });

  it("classifies controlled healthy and degraded fixtures without retaining prompts or credentials", () => {
    const good = buildObservation(fixture("passive-monitor-healthy.json"), { environment: "development", knownSecrets: ["fixture-token"] });
    const degraded = buildObservation(fixture("passive-monitor-degraded.json"), { environment: "development", knownSecrets: ["fixture-token"] });
    expect(good).toMatchObject({ kind: "healthy", failures: [] });
    expect(degraded).toMatchObject({ kind: "product_failure", request_ids: ["req_fixture_01", "trace_fixture_02"], failures: expect.arrayContaining([expect.objectContaining({ code: "storage_down", alert_class: "storage" }), expect.objectContaining({ code: "stale_runs", alert_class: "queue" })]) });
    expect(JSON.stringify(degraded)).not.toMatch(/fixture-token|private task body/);
  });

  it("clears persisted recovery_pending on a flap and edits the issue body", () => {
    const observation = buildObservation(failed(["gateway_capability_missing"]), { environment: "development" });
    const fingerprint = observation.failures[0].fingerprint;
    const action = planIncidentTransitions({ observation, incidents: [{ number: 73, state: "CLOSED", fingerprint, recovery_pending: true }] }).actions[0];
    expect(issueBodyForAction(action, observation)).toMatch(new RegExp(`harness-arena-monitor:.*\\"fingerprint\\":\\"${fingerprint}\\".*\\"recovery_pending\\":false`));
    const { result, calls } = runApplier([{ observation, actions: [action] }]);
    expect(result.status).toBe(0);
    expect(calls.map(({ argv }) => argv.slice(0, 2))).toEqual([["issue", "reopen"], ["issue", "comment"], ["issue", "edit"]]);
  });

  it("includes only validated request and trace identifiers in incident payloads", () => {
    const observation = buildObservation(fixture("passive-monitor-degraded.json"), { environment: "development" });
    const body = issueBodyForAction({ action: "create", reason: "new_failure", fingerprint: observation.failures[0].fingerprint, failure: observation.failures[0] }, observation);
    expect(body).toMatch(/Correlation IDs: req_fixture_01, trace_fixture_02/);
    expect(body).not.toMatch(/fixture-token|private task body/);
  });
});

describe("monitor workflow contract", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/passive-agent-monitor.yml", import.meta.url), "utf8");
  const runbook = readFileSync(new URL("../../docs/runbooks/passive-agent-monitoring.md", import.meta.url), "utf8");

  it("has only required GitHub permissions, bounded execution, sanitized artifacts, and no infrastructure mutation", () => {
    expect(workflow).toMatch(/contents:\s*read/);
    expect(workflow).toMatch(/issues:\s*write/);
    expect(workflow).toMatch(/timeout-minutes:\s*[1-9]/);
    expect(workflow).toMatch(/passive-monitor\.mjs/);
    expect(workflow).toMatch(/retention-days:\s*[1-9]/);
    expect(workflow).not.toMatch(/\b(?:deploy|promote|rollback|alias|env\s+(?:add|rm|pull)|blob|admin)\b/i);
    expect(workflow).not.toMatch(/(?:VERCEL_TOKEN|BLOB_READ_WRITE_TOKEN|RUNNER_CALLBACK_SECRET|AI_GATEWAY_API_KEY)/);
    expect(workflow).not.toMatch(/--label\s+agent-monitor/);
    expect(workflow).toMatch(/--search\s+"\[agent-monitor\] in:title"/);
    expect(workflow).toMatch(/node scripts\/ops\/agent-status\.mjs --env development --json/);
    expect(workflow).toMatch(/node scripts\/ops\/agent-status\.mjs --env production --json/);
    expect(workflow).not.toMatch(/pnpm ops:status/);
    expect(runbook).toMatch(/GET-only/i);
    expect(runbook).toMatch(/access_blocked/i);
  });

  it("sanitizes retained artifacts and issue evidence", () => {
    const record = sanitizeMonitorRecord({ prompt: "private prompt", authorization: "Bearer monitor-token", nested: { error: "token=monitor-token" } }, ["monitor-token"]);
    expect(JSON.stringify(record)).not.toMatch(/monitor-token|private prompt|Bearer/);
  });

  it("allows only GitHub issue state changes after a plan and never runs infrastructure commands", () => {
    const applier = readFileSync(new URL("./apply-passive-monitor-plan.mjs", import.meta.url), "utf8");
    expect(applier).toMatch(/spawn\("gh", args, \{ shell: false/);
    expect(applier).not.toMatch(/\b(?:vercel|curl|fetch\(|POST|PUT|PATCH|DELETE|blob|admin)\b/i);
    expect(applier).toMatch(/\["issue", "(?:create|comment|edit|close|reopen)"/);
  });

  it("creates an incident without requiring a repository label", () => {
    const observation = buildObservation(failed(["storage_down"]), { environment: "development" });
    const action = planIncidentTransitions({ observation, incidents: [] }).actions[0];
    const { result, calls } = runApplier([{ observation, actions: [action] }]);
    expect(result.status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual(expect.arrayContaining(["issue", "create", "--body-file", "-"]));
    expect(calls[0].argv).not.toEqual(expect.arrayContaining(["--label", "agent-monitor"]));
  });
});
