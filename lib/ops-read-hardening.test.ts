import { describe, expect, it } from "vitest";
import {
  OPS_RECORD_KINDS,
  decodeOpsCursor,
  encodeOpsCursor,
  opsAuthorized,
  redactOpsValue,
} from "./ops-read";

describe("ops read hardening contract", () => {
  it("covers every persisted writer namespace", () => {
    expect(OPS_RECORD_KINDS.map((entry) => entry.prefix)).toEqual([
      "submissions/", "runs/", "competitions/", "events/", "traces/",
      "voice/manifest.json", "voice/judgments/", "voice/audio/prompts/",
      "voice/audio/responses/", "archives/competition-cleanup-operations/",
      "archives/competition-cleanups/", "archives/competition-resets/", "archives/",
    ]);
  });

  it("requires exact Bearer grammar and rejects tampered or cross-kind cursors", () => {
    process.env.OPS_READ_TOKEN = "read-token";
    process.env.OPS_READ_CURSOR_SECRET = "cursor-secret";
    expect(opsAuthorized("Bearer read-token")).toBe(true);
    expect(opsAuthorized("bearer read-token")).toBe(false);
    expect(opsAuthorized("Bearer  read-token")).toBe(false);
    const cursor = encodeOpsCursor({ kind: "runs", prefix: "runs/", blob_cursor: "next", snapshot_at: "2026-08-02T00:00:00.000Z" });
    expect(decodeOpsCursor(cursor, { kind: "runs", prefix: "runs/" })).toMatchObject({ blob_cursor: "next" });
    expect(() => decodeOpsCursor(cursor + "x", { kind: "runs", prefix: "runs/" })).toThrow("invalid_cursor");
    expect(() => decodeOpsCursor(cursor, { kind: "events", prefix: "events/" })).toThrow("invalid_cursor");
  });

  it("recursively redacts credential queries, secret keys, and exact environment secrets", () => {
    process.env.BLOB_READ_WRITE_TOKEN = "rw-secret";
    expect(redactOpsValue({ nested: ["https://x.test/a?token=signed", "rw-secret"], api_key: "leak" })).toEqual({ nested: ["https://x.test/a", "[REDACTED]"], api_key: "[REDACTED]" });
  });

  it("redacts quoted and camel-case credentials in stringified JSON and nested errors", () => {
    const error = new Error('failed={"access_token":"error-access","refresh_token":"error-refresh","clientSecret":"error-client"}');
    const output = JSON.stringify(redactOpsValue({
      error,
      nested: ['{"access_token":"nested-access","refresh_token":"nested-refresh","clientSecret":"nested-client"}'],
    }));
    for (const leaked of ["error-access", "error-refresh", "error-client", "nested-access", "nested-refresh", "nested-client"]) expect(output).not.toContain(leaked);
    expect(output).toContain("[REDACTED]");
  });
});
