import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresEntrantTraces } from "./postgres";

const migration = (name: string) => readFileSync(path.join(process.cwd(), "db", "migrations", name), "utf8");
const ALICE = { id: "00000000-0000-0000-0000-000000000101", github_id: 101, github_login: "alice" };
const BOB = { id: "00000000-0000-0000-0000-000000000202", github_id: 202, github_login: "bob" };
const SHA = "a".repeat(64);

let db: PGlite;
let serial = 400;

beforeEach(async () => {
  db = await PGlite.create();
  await db.exec(migration("0001_agent_network.sql"));
  await db.exec(migration("0002_competition_chat.sql"));
  await db.exec(migration("0003_submission_artifacts.sql"));
  serial = 400;
  await db.exec(`
    INSERT INTO entrants (id, github_id, github_login) VALUES
      ('${ALICE.id}', ${ALICE.github_id}, '${ALICE.github_login}'),
      ('${BOB.id}', ${BOB.github_id}, '${BOB.github_login}');
    INSERT INTO submission_bindings (submission_id, competition_id, entrant_id)
      VALUES ('sub-a', 'comp-a', '${ALICE.id}'), ('sub-b', 'comp-a', '${BOB.id}');
  `);
});

afterEach(async () => { await db.close(); });

function traces() {
  return createPostgresEntrantTraces(db, {
    ids: { next: () => `00000000-0000-0000-0000-${String(serial++).padStart(12, "0")}` },
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  });
}

const execution = {
  submission_id: "sub-a", kind: "execution", schema_version: "execution.v1", mime_type: "application/json",
  compression: "gzip", compressed_bytes: 128, uncompressed_bytes: 512, sha256: SHA, consent: "entrant-upload.v1",
};

describe("0003 durable submission artifact metadata", () => {
  it("is transactional and repeatable, with private object keys rather than public URLs", async () => {
    await db.exec(migration("0003_submission_artifacts.sql"));
    expect(migration("0003_submission_artifacts.sql")).toMatch(/^\s*BEGIN\s*;/i);
    expect(migration("0003_submission_artifacts.sql")).toMatch(/COMMIT\s*;\s*$/i);
    const columns = await db.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'submission_artifacts'
    `);
    expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      "id", "submission_id", "owner_entrant_id", "kind", "schema_version", "object_key", "sha256",
      "compression", "compressed_bytes", "uncompressed_bytes", "mime_type", "consent", "state", "reconcile_after",
    ]));
    for (const row of columns.rows) expect(row.column_name).not.toMatch(/(?:prompt|token|trace|url)/i);
  });

  it("pins owner/submission binding, one artifact per kind/schema, bounds, state lifecycle, and verified identity immutability", async () => {
    const definitions = await db.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      WHERE c.conrelid = 'submission_artifacts'::regclass
    `);
    const all = definitions.rows.map((row) => row.definition).join(" ");
    expect(all).toMatch(/UNIQUE.*submission_id.*kind.*schema_version/i);
    expect(all).toMatch(/FOREIGN KEY.*submission_bindings/i);
    expect(all).toMatch(/CHECK.*pending_upload.*uploaded.*verified.*rejected/i);
    expect(all).toMatch(/CHECK.*sha256/i);
  });

  it("prepares exactly once per operation, replays unchanged requests, and conflicts on a changed body of metadata", async () => {
    const repo = traces();
    const first = await repo.prepare({ actor: ALICE, operation_id: "prepare-1", artifact: execution });
    expect(first).toMatchObject({ ok: true, artifact: { state: "pending_upload", object_key: expect.stringMatching(/^private\//) } });
    await expect(repo.prepare({ actor: ALICE, operation_id: "prepare-1", artifact: { ...execution } })).resolves.toEqual(first);
    await expect(repo.prepare({ actor: ALICE, operation_id: "prepare-1", artifact: { ...execution, sha256: "b".repeat(64) } })).resolves.toEqual({ ok: false, error: { code: "conflict" } });

    const [concurrentOne, concurrentTwo] = await Promise.all([
      repo.prepare({ actor: BOB, operation_id: "prepare-concurrent", artifact: { ...execution, submission_id: "sub-b" } }),
      repo.prepare({ actor: BOB, operation_id: "prepare-concurrent", artifact: { submission_id: "sub-b", consent: execution.consent, sha256: SHA, uncompressed_bytes: 512, compressed_bytes: 128, compression: "gzip", mime_type: "application/json", schema_version: "execution.v1", kind: "execution" } }),
    ]);
    expect(concurrentTwo).toEqual(concurrentOne);
  });

  it("pins every prepare write to the injected transaction-scoped SQL client", async () => {
    const transaction = vi.fn(async <Result>(callback: (tx: PGlite) => Promise<Result>) => db.transaction(callback));
    const repo = createPostgresEntrantTraces({ exec: db.exec.bind(db), query: db.query.bind(db), transaction }, {
      ids: { next: () => `00000000-0000-0000-0000-${String(serial++).padStart(12, "0")}` },
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    });
    await expect(repo.prepare({ actor: ALICE, operation_id: "prepare-transaction", artifact: execution })).resolves.toMatchObject({ ok: true });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("records upload, verifies the final checksum, rejects mismatches, and exposes due reconciliation work", async () => {
    const repo = traces();
    const prepared = await repo.prepare({ actor: ALICE, operation_id: "prepare-finalize", artifact: execution });
    if (!prepared.ok) throw new Error("fixture prepare failed");
    await expect(repo.finalize({ actor: ALICE, artifact_id: prepared.artifact.id, sha256: SHA })).resolves.toEqual({ ok: false, error: { code: "invalid_state" } });
    await expect(repo.recordUpload({ actor: ALICE, artifact_id: prepared.artifact.id, sha256: SHA, compressed_bytes: 128 })).resolves.toMatchObject({ ok: true, artifact: { state: "uploaded" } });
    await expect(repo.reconcileDue({ before: new Date("2026-08-03T00:00:00.000Z") })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: prepared.artifact.id, state: "uploaded" }),
    ]));
    await expect(repo.finalize({ actor: ALICE, artifact_id: prepared.artifact.id, sha256: SHA })).resolves.toMatchObject({ ok: true, artifact: { state: "verified" } });
    await expect(repo.finalize({ actor: ALICE, artifact_id: prepared.artifact.id, sha256: "b".repeat(64) })).resolves.toEqual({ ok: false, error: { code: "conflict" } });
    await expect(db.query(
      "UPDATE submission_artifacts SET object_key = $2 WHERE id = $1",
      [prepared.artifact.id, "private/tampered"],
    )).rejects.toThrow();

    const mismatch = await repo.prepare({
      actor: BOB,
      operation_id: "prepare-mismatch",
      artifact: { ...execution, submission_id: "sub-b", sha256: "b".repeat(64) },
    });
    if (!mismatch.ok) throw new Error("fixture prepare failed");
    await expect(repo.recordUpload({ actor: BOB, artifact_id: mismatch.artifact.id, sha256: SHA, compressed_bytes: 128 })).resolves.toMatchObject({
      ok: false,
      error: { code: "checksum_mismatch" },
      artifact: { state: "rejected" },
    });
  });

  it("denies cross-user reads and returns public metadata DTOs without bytes, prompts, tokens, or URLs", async () => {
    const repo = traces();
    const prepared = await repo.prepare({ actor: ALICE, operation_id: "prepare-private", artifact: execution });
    if (!prepared.ok) throw new Error("fixture prepare failed");
    await expect(repo.getForOwner({ actor: BOB, artifact_id: prepared.artifact.id })).resolves.toEqual({ ok: false, error: { code: "not_found" } });
    const own = await repo.getForOwner({ actor: ALICE, artifact_id: prepared.artifact.id });
    expect(own).toMatchObject({ ok: true, artifact: { id: prepared.artifact.id, submission_id: "sub-a" } });
    if (!own.ok) throw new Error("fixture owner read failed");
    for (const field of ["bytes", "body", "prompt", "token", "url", "signed_url", "object_key", "owner_entrant_id"] as const) expect(own.artifact).not.toHaveProperty(field);
  });
});
