import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresCompetitionEntryLedger } from "./postgres-ledger";

const migration = (name: string) => readFileSync(path.join(process.cwd(), "db", "migrations", name), "utf8");
const entrant = { entrant_id: "00000000-0000-0000-0000-000000000041", github_id: 4242, github_login: "octo" };
const request = {
  schema_version: "submit_entry.v1",
  competition_id: "comp-live",
  idempotency_key: "entry-key-001",
  entry: { kind: "prompt.v1", agent_name: "Octo", prompt: "private durable prompt" },
};
const ids = [
  "00000000-0000-0000-0000-000000000101",
  "00000000-0000-0000-0000-000000000102",
  "00000000-0000-0000-0000-000000000103",
  "00000000-0000-0000-0000-000000000104",
  "00000000-0000-0000-0000-000000000105",
  "00000000-0000-0000-0000-000000000106",
];
let db: PGlite;

beforeEach(async () => {
  db = await PGlite.create();
  await db.exec(migration("0001_agent_network.sql"));
  await db.exec(migration("0008_entry_saga.sql"));
  await db.query(
    "INSERT INTO entrants (id, github_id, github_login) VALUES ($1, $2::bigint, $3)",
    [entrant.entrant_id, entrant.github_id, entrant.github_login],
  );
});

afterEach(async () => {
  await db.close();
});

function ledger() {
  let index = 0;
  return createPostgresCompetitionEntryLedger(db, {
    ids: () => ids[index++],
    now: () => new Date("2026-08-03T00:00:00.000Z"),
  });
}

describe("0008 durable competition-entry PostgreSQL ledger", () => {
  it("is a readiness migration and reserves one short-lived saga transaction with private canonical request state and deterministic UUID entity IDs", async () => {
    const subject = ledger();
    const first = await subject.reserve({ actor: entrant, request });
    const replay = await subject.reserve({ actor: entrant, request: { ...request, entry: { ...request.entry } } });

    expect(first).toMatchObject({ phase: "reserved", replay: undefined });
    expect(first.submission_id).toMatch(/^00000000-0000-0000-0000-00000000010[23]$/);
    expect(first.run_id).toMatch(/^00000000-0000-0000-0000-00000000010[23]$/);
    expect(first.run_id).not.toBe(first.submission_id);
    expect(replay).toEqual({ ...first, replay: undefined });
    await expect(subject.reserve({ actor: entrant, request: { ...request, entry: { ...request.entry, prompt: "changed" } } }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" });

    const operation = await db.query<{ request_json: unknown; request_hash: string; phase: string }>(
      "SELECT request_json, request_hash, phase FROM competition_entry_sagas WHERE operation_id = $1",
      [first.operation_id],
    );
    expect(operation.rows).toEqual([expect.objectContaining({ request_json: request, request_hash: expect.stringMatching(/^[a-f0-9]{64}$/), phase: "reserved" })]);
    await expect(db.query("SELECT version FROM schema_migrations WHERE version = '0008_entry_saga'"))
      .resolves.toMatchObject({ rows: [{ version: "0008_entry_saga" }] });

    const concurrentRequest = { ...request, idempotency_key: "entry-key-concurrent" };
    const [one, two] = await Promise.all([
      subject.reserve({ actor: entrant, request: concurrentRequest }),
      subject.reserve({ actor: entrant, request: concurrentRequest }),
    ]);
    expect(one.operation_id).toBe(two.operation_id);
    await expect(db.query("SELECT count(*)::int AS count FROM competition_entry_sagas WHERE idempotency_key = $1", [concurrentRequest.idempotency_key]))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("loads the immutable actor and private request only at the private seam, preserves the verdict across monotonic CAS checkpoints, and rejects an ambiguous in-flight judge", async () => {
    const subject = ledger();
    const reserved = await subject.reserve({ actor: entrant, request });

    await subject.checkpoint({ operation_id: reserved.operation_id, expected_phase: "reserved", phase: "judge_started" });
    await expect(subject.load({ operation_id: reserved.operation_id })).resolves.toMatchObject({
      actor: { entrantId: entrant.entrant_id, githubId: entrant.github_id, githubLogin: entrant.github_login },
      request,
      phase: "judge_started",
      reconciliation_required: true,
    });
    await expect(subject.checkpoint({ operation_id: reserved.operation_id, expected_phase: "reserved", phase: "verdict_persisted", value: { verdict: "approved", reason: "safe" } }))
      .rejects.toMatchObject({ code: "ENTRY_SAGA_PHASE_CONFLICT" });

    // A separate reserved operation proves the normal monotonic path retains
    // the verdict even after later phase values no longer carry it.
    const normal = await subject.reserve({ actor: entrant, request: { ...request, idempotency_key: "entry-key-002" } });
    await subject.checkpoint({ operation_id: normal.operation_id, expected_phase: "reserved", phase: "judge_started" });
    await subject.checkpoint({ operation_id: normal.operation_id, expected_phase: "judge_started", phase: "verdict_persisted", value: { verdict: "approved", reason: "safe" } });
    await subject.checkpoint({ operation_id: normal.operation_id, expected_phase: "verdict_persisted", phase: "submission_written" });
    await expect(subject.load({ operation_id: normal.operation_id })).resolves.toMatchObject({
      phase: "submission_written",
      verdict: { verdict: "approved", reason: "safe" },
    });

    const publicView = await subject.project({ operation_id: normal.operation_id });
    expect(JSON.stringify(publicView)).not.toContain(request.entry.prompt);
    expect(JSON.stringify(publicView)).not.toContain("request_json");
  });

  it("completes atomically with submission binding, active membership, audit and outbox records without accepting an external callback", async () => {
    const subject = ledger();
    const reserved = await subject.reserve({ actor: entrant, request });
    await subject.checkpoint({ operation_id: reserved.operation_id, expected_phase: "reserved", phase: "judge_started" });
    await subject.checkpoint({ operation_id: reserved.operation_id, expected_phase: "judge_started", phase: "verdict_persisted", value: { verdict: "approved", reason: "safe" } });
    await subject.checkpoint({ operation_id: reserved.operation_id, expected_phase: "verdict_persisted", phase: "submission_written" });
    await subject.checkpoint({ operation_id: reserved.operation_id, expected_phase: "submission_written", phase: "run_written" });
    await subject.checkpoint({ operation_id: reserved.operation_id, expected_phase: "run_written", phase: "run_created_appended" });

    await subject.complete({ operation_id: reserved.operation_id, response: { submission_id: reserved.submission_id, run_id: reserved.run_id, status: "queued" } });

    await expect(db.query("SELECT entrant_id FROM submission_bindings WHERE submission_id = $1", [reserved.submission_id]))
      .resolves.toMatchObject({ rows: [{ entrant_id: entrant.entrant_id }] });
    await expect(db.query("SELECT state FROM competition_memberships WHERE competition_id = $1 AND entrant_id = $2", [request.competition_id, entrant.entrant_id]))
      .resolves.toMatchObject({ rows: [{ state: "active" }] });
    await expect(db.query("SELECT state, response_json FROM competition_entry_sagas WHERE operation_id = $1", [reserved.operation_id]))
      .resolves.toMatchObject({ rows: [{ state: "completed", response_json: { submission_id: reserved.submission_id, run_id: reserved.run_id, status: "queued" } }] });
    await expect(db.query("SELECT count(*)::int AS count FROM domain_audit_events WHERE correlation_id = $1", [reserved.operation_id]))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(db.query("SELECT count(*)::int AS count FROM domain_outbox WHERE operation_id = $1", [reserved.operation_id]))
      .resolves.toMatchObject({ rows: [{ count: expect.any(Number) }] });
    await expect(subject.reserve({ actor: entrant, request })).resolves.toMatchObject({
      operation_id: reserved.operation_id,
      replay: { submission_id: reserved.submission_id, run_id: reserved.run_id, status: "queued" },
    });
  });

  it("collapses the same reservation across independent service instances", async () => {
    let serialId = 700;
    const first = createPostgresCompetitionEntryLedger(db, {
      ids: () => `00000000-0000-0000-0000-${String(serialId++).padStart(12, "0")}`,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    });
    const second = createPostgresCompetitionEntryLedger(db, {
      ids: () => `00000000-0000-0000-0000-${String(serialId++).padStart(12, "0")}`,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    });

    const [one, two] = await Promise.all([
      first.reserve({ actor: entrant, request }),
      second.reserve({ actor: entrant, request }),
    ]);

    expect(two).toEqual(one);
    await expect(db.query("SELECT count(*)::int AS count FROM competition_entry_sagas WHERE idempotency_key=$1", [request.idempotency_key]))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("refuses premature or mismatched completion and emits one audit/outbox effect under concurrent replay", async () => {
    const subject = ledger();
    const reserved = await subject.reserve({ actor: entrant, request });

    await expect(subject.complete({ operation_id: reserved.operation_id, response: { submission_id: reserved.submission_id, run_id: reserved.run_id, status: "queued" } }))
      .rejects.toMatchObject({ code: "ENTRY_SAGA_PHASE_CONFLICT" });
    await expect(subject.complete({ operation_id: reserved.operation_id, response: { submission_id: "different", run_id: reserved.run_id, status: "queued" } }))
      .rejects.toMatchObject({ code: "ENTRY_SAGA_PHASE_CONFLICT" });
    await expect(db.query("SELECT count(*)::int AS count FROM domain_audit_events WHERE correlation_id=$1", [reserved.operation_id]))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });

    await subject.checkpoint({ operation_id: reserved.operation_id, expected_phase: "reserved", phase: "judge_started" });
    await subject.checkpoint({ operation_id: reserved.operation_id, expected_phase: "judge_started", phase: "verdict_persisted", value: { verdict: "approved", reason: "safe" } });
    await subject.checkpoint({ operation_id: reserved.operation_id, expected_phase: "verdict_persisted", phase: "submission_written" });
    await subject.checkpoint({ operation_id: reserved.operation_id, expected_phase: "submission_written", phase: "run_written" });
    await subject.checkpoint({ operation_id: reserved.operation_id, expected_phase: "run_written", phase: "run_created_appended" });
    const response = { submission_id: reserved.submission_id, run_id: reserved.run_id, status: "queued" as const };
    await Promise.all([subject.complete({ operation_id: reserved.operation_id, response }), subject.complete({ operation_id: reserved.operation_id, response })]);

    await expect(db.query("SELECT count(*)::int AS count FROM domain_audit_events WHERE correlation_id=$1", [reserved.operation_id]))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(db.query("SELECT count(*)::int AS count FROM domain_outbox WHERE operation_id=$1", [reserved.operation_id]))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
  });
});
