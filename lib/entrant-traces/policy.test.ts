import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createEntrantTracePolicy } from "./policy";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function artifact(kind: "execution" | "rationale", compression: "none" | "gzip", bytes: Buffer, uncompressedBytes = bytes.byteLength) {
  return { kind, compression, sha256: sha256(bytes), uncompressed_bytes: uncompressedBytes, bytes };
}

describe("entrant trace policy boundary", () => {
  it("streams gzip to the configured ceiling and requires the exact declared uncompressed byte count", async () => {
    const policy = createEntrantTracePolicy({ maxUncompressedBytes: 1_024, scanTimeoutMs: 50 });
    const oversized = gzipSync(Buffer.from("x".repeat(1_025)));

    await expect(policy.verify(artifact("execution", "gzip", oversized, 1_025))).resolves.toEqual({
      ok: false,
      disposition: "rejected",
      error: { code: "uncompressed_bytes_exceed_limit" },
    });

    await expect(policy.verify(artifact("execution", "none", Buffer.from("{}"), 3))).resolves.toEqual({
      ok: false,
      disposition: "rejected",
      error: { code: "uncompressed_size_mismatch" },
    });
  });

  it("accepts only allowlisted JSON schemas: operational execution events and self-authored rationale", async () => {
    const policy = createEntrantTracePolicy({ maxUncompressedBytes: 1_024, scanTimeoutMs: 50, scan: vi.fn().mockResolvedValue({ ok: true }) });
    const execution = Buffer.from(JSON.stringify({ schema_version: "execution.v1", events: [{ at: "2026-08-03T00:00:00.000Z", type: "tool.completed", tool: "tests", exit_code: 0 }] }));
    const rationale = Buffer.from(JSON.stringify({ schema_version: "rationale.v1", authored_by: "entrant", summary: "I ran the verifier and selected the passing result." }));

    await expect(policy.verify(artifact("execution", "none", execution))).resolves.toMatchObject({ ok: true, verified_sha256: sha256(execution) });
    await expect(policy.verify(artifact("rationale", "none", rationale))).resolves.toMatchObject({ ok: true, verified_sha256: sha256(rationale) });
    await expect(policy.verify(artifact("execution", "none", Buffer.from('{"schema_version":"execution.v2"}')))).resolves.toEqual({
      ok: false,
      disposition: "rejected",
      error: { code: "schema_not_allowlisted" },
    });
  });

  it("fails closed instead of approving an otherwise valid trace when no scanner is configured", async () => {
    const policy = createEntrantTracePolicy({ maxUncompressedBytes: 1_024, scanTimeoutMs: 50 });
    const bytes = Buffer.from('{"schema_version":"execution.v1","events":[]}');

    await expect(policy.verify(artifact("execution", "none", bytes))).resolves.toEqual({
      ok: false,
      disposition: "manual_review",
      error: { code: "scanner_unavailable" },
    });
  });

  it("fails closed without logging or returning sensitive values found in keys or values", async () => {
    const policy = createEntrantTracePolicy({ maxUncompressedBytes: 1_024, scanTimeoutMs: 50 });
    const secret = "test-only-sensitive-material";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    for (const payload of [
      { schema_version: "execution.v1", events: [{ type: "tool.completed", access_token: secret }] },
      { schema_version: "execution.v1", events: [{ type: "tool.completed", detail: `cookie=${secret}` }] },
      { schema_version: "rationale.v1", authored_by: "entrant", summary: "safe", context: { signed_url: secret } },
      { schema_version: "rationale.v1", authored_by: "entrant", summary: `private key: ${secret}` },
      { schema_version: "rationale.v1", authored_by: "entrant", summary: "hidden chain-of-thought follows" },
      { schema_version: "execution.v1", events: [{ type: "tool.completed", env: secret }] },
      { schema_version: "execution.v1", events: [{ type: "tool.completed", prompt: secret }] },
    ]) {
      const result = await policy.verify(artifact("execution", "none", Buffer.from(JSON.stringify(payload))));
      expect(result).toEqual({ ok: false, disposition: "rejected", error: { code: "sensitive_content" } });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("sends parse, scanner timeout, and scanner failures to manual review rather than eligibility", async () => {
    const scanner = vi.fn().mockImplementationOnce(() => new Promise(() => undefined)).mockRejectedValueOnce(new Error("unavailable"));
    const policy = createEntrantTracePolicy({ maxUncompressedBytes: 1_024, scanTimeoutMs: 1, scan: scanner });

    await expect(policy.verify(artifact("execution", "none", Buffer.from("not-json")))).resolves.toEqual({
      ok: false, disposition: "manual_review", error: { code: "invalid_json" },
    });
    await expect(policy.verify(artifact("execution", "none", Buffer.from('{"schema_version":"execution.v1","events":[]}')))).resolves.toEqual({
      ok: false, disposition: "manual_review", error: { code: "scan_timeout" },
    });
    await expect(policy.verify(artifact("execution", "none", Buffer.from('{"schema_version":"execution.v1","events":[]}')))).resolves.toEqual({
      ok: false, disposition: "manual_review", error: { code: "scan_error" },
    });
  });

  it("fails closed when the scanner explicitly rejects otherwise valid content", async () => {
    const bytes = Buffer.from('{"schema_version":"execution.v1","events":[]}');
    const policy = createEntrantTracePolicy({
      maxUncompressedBytes: 1_024,
      scanTimeoutMs: 50,
      scan: vi.fn().mockResolvedValue({ ok: false, code: "malware" }),
    });

    await expect(policy.verify(artifact("execution", "none", bytes))).resolves.toEqual({
      ok: false, disposition: "rejected", error: { code: "scan_rejected" },
    });
  });
});
