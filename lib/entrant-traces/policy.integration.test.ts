import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateEntrantTraceManifest } from "./manifest";

const migration = (name: string) => readFileSync(path.join(process.cwd(), "db", "migrations", name), "utf8");
let db: PGlite;

beforeEach(async () => {
  db = await PGlite.create();
  for (const name of [
    "0001_agent_network.sql",
    "0002_competition_chat.sql",
    "0003_submission_artifacts.sql",
    "0004_payout_profiles.sql",
    "0005_competition_chat_sequences.sql",
    "0006_trace_policy.sql",
  ]) await db.exec(migration(name));
});

afterEach(async () => { await db.close(); });

describe("0006 trace policy and reconciliation metadata", () => {
  it("derives the database compression contract from every mode accepted by the manifest", async () => {
    const accepted = (["none", "gzip"] as const).filter((compression) => validateEntrantTraceManifest({
      schema_version: "trace-manifest.v1",
      submission_id: "submission-1",
      artifacts: [
        { kind: "execution", schema_version: "execution.v1", mime_type: "application/json", compression, compressed_bytes: 2, uncompressed_bytes: 2, sha256: "a".repeat(64) },
        { kind: "rationale", schema_version: "rationale.v1", mime_type: "application/json", compression, compressed_bytes: 2, uncompressed_bytes: 2, sha256: "b".repeat(64) },
      ],
    }).ok);
    const constraints = await db.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'submission_artifacts'::regclass AND contype = 'c'
    `);
    const definitions = constraints.rows.map(({ definition }) => definition).join(" ");
    for (const compression of accepted) expect(definitions).toContain(compression);

    await db.exec(`
      INSERT INTO entrants (id, github_id, github_login) VALUES ('00000000-0000-0000-0000-000000000101', 101, 'alice');
      INSERT INTO submission_bindings (submission_id, competition_id, entrant_id)
      VALUES ('submission-1', 'competition-1', '00000000-0000-0000-0000-000000000101');
      INSERT INTO submission_artifacts (
        id, submission_id, owner_entrant_id, kind, schema_version, object_key, sha256,
        compression, compressed_bytes, uncompressed_bytes, mime_type, consent, state, reconcile_after
      ) VALUES (
        '00000000-0000-0000-0000-000000000601', 'submission-1', '00000000-0000-0000-0000-000000000101',
        'rationale', 'rationale.v1', 'private/artifacts/00000000-0000-0000-0000-000000000601', repeat('a', 64),
        'none', 2, 2, 'application/json', 'trace-evidence.v1', 'pending_upload', CURRENT_TIMESTAMP
      );
    `);
  });

  it("adds fail-closed scan, retention, and deletion metadata without storing trace content", async () => {
    await expect(db.exec(migration("0006_trace_policy.sql"))).resolves.toBeDefined();
    const columns = await db.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'submission_artifacts'
    `);
    const names = columns.rows.map(({ column_name }) => column_name);
    expect(names).toEqual(expect.arrayContaining([
      "scan_state", "scan_revision", "scan_summary", "policy_verified_at", "retained_until", "deleted_at",
    ]));
    expect(names.join(" ")).not.toMatch(/trace_body|artifact_bytes|prompt|private_reasoning/i);
  });
});
