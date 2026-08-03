import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildObservation,
  planIncidentTransitions,
  sanitizeMonitorRecord,
  stableFingerprint,
} from "./passive-monitor.mjs";

const healthy = { environment: "development", verdict: "healthy", checked_at: "2026-08-03T12:00:00.000Z", health: { sha: "abcdef1" }, platform: { deployment: { id: "dpl_1", sha: "abcdef1" } }, findings: [], blockers: [] };
const failed = (codes, sha = "abcdef1") => ({ ...healthy, verdict: "failed", health: { sha }, platform: { deployment: { id: "dpl_1", sha } }, findings: codes.map((code) => ({ code, severity: "failed", detail: `secret=monitor-token prompt=private request ${code}` })) });

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
    const [storage, stale] = one.failures;
    const incidents = [
      { number: 41, state: "OPEN", fingerprint: storage.fingerprint, evidence_sha: "abcdef1" },
      { number: 42, state: "OPEN", fingerprint: stale.fingerprint, evidence_sha: "abcdef1" },
    ];
    expect(planIncidentTransitions({ observation: one, incidents }).actions).toEqual([]);

    const changedDeployment = buildObservation(failed(["storage_down"], "fedcba2"), { environment: "development" });
    expect(planIncidentTransitions({ observation: changedDeployment, incidents }).actions).toEqual([
      expect.objectContaining({ action: "comment", number: 41, reason: "deployment_changed" }),
      expect.objectContaining({ action: "comment", number: 42, reason: "recovery_pending" }),
    ]);

    const partial = planIncidentTransitions({ observation: changedDeployment, incidents: [{ ...incidents[0], evidence_sha: "fedcba2" }, { ...incidents[1], recovery_pending: true }] });
    expect(partial.actions).toEqual([expect.objectContaining({ action: "close", number: 42, reason: "recovery_proven" })]);
    const full = planIncidentTransitions({ observation: buildObservation(healthy, { environment: "development" }), incidents: [{ ...incidents[0], evidence_sha: "fedcba2" }, { ...incidents[1], recovery_pending: true }] });
    expect(full.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "comment", number: 41, reason: "recovery_pending" }),
      expect.objectContaining({ action: "close", number: 42, reason: "recovery_proven" }),
    ]));
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
    expect(runbook).toMatch(/GET-only/i);
    expect(runbook).toMatch(/access_blocked/i);
  });

  it("sanitizes retained artifacts and issue evidence", () => {
    const record = sanitizeMonitorRecord({ prompt: "private prompt", authorization: "Bearer monitor-token", nested: { error: "token=monitor-token" } }, ["monitor-token"]);
    expect(JSON.stringify(record)).not.toMatch(/monitor-token|private prompt|Bearer/);
  });
});
