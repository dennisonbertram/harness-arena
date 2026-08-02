import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    "0007_payout_eligibility.sql",
  ]) await db.exec(migration(name));
});

afterEach(async () => { await db.close(); });

describe("0007 immutable payout eligibility freeze", () => {
  it("adds an entry-level, immutable cutoff snapshot with no transfer or payment fields", async () => {
    await expect(db.exec(migration("0007_payout_eligibility.sql"))).resolves.toBeDefined();
    const columns = await db.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payout_eligibility_freezes'
    `);
    const names = columns.rows.map(({ column_name }) => column_name);
    expect(names).toEqual(expect.arrayContaining([
      "id", "competition_id", "submission_id", "entrant_id", "frozen_by_entrant_id",
      "status", "reason_code", "policy_version", "cutoff_at", "snapshot", "created_at",
    ]));
    expect(names).toEqual(expect.arrayContaining([
      "result_rank", "result_score", "judge_revision", "trace_sha256", "trace_scan_revision",
      "payout_address", "payout_chain_id", "payout_profile_verified_at",
    ]));
    expect(names.join(" ")).not.toMatch(/transfer|payment|amount|currency|transaction|private.?key/i);

    const constraints = await db.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = 'payout_eligibility_freezes'::regclass
    `);
    const rules = constraints.rows.map(({ definition }) => definition).join(" ");
    expect(rules).toMatch(/UNIQUE.*competition_id.*submission_id/i);
    expect(rules).toMatch(/FOREIGN KEY.*entrants/i);
    expect(rules).toMatch(/CHECK.*payout_chain_id.*1/i);
    expect(rules).toMatch(/CHECK.*trace_sha256/i);
    expect(rules).toMatch(/schema_version.*payout-eligibility\.v1/i);

    const triggers = await db.query<{ tgname: string }>(`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'payout_eligibility_freezes'::regclass AND NOT tgisinternal
    `);
    expect(triggers.rows.map(({ tgname }) => tgname).join(" ")).toMatch(/immutable|freeze/i);
  });

  it("rejects update and delete of every frozen eligibility row at the database boundary", async () => {
    await db.exec(`
      INSERT INTO entrants (id, github_id, github_login)
      VALUES ('00000000-0000-0000-0000-000000000101', 101, 'freeze-owner');
      INSERT INTO payout_eligibility_freezes (
        id, competition_id, submission_id, entrant_id, frozen_by_entrant_id, status, reason_code, policy_version,
        cutoff_at, snapshot, result_rank, result_score, judge_revision, trace_sha256, trace_scan_revision,
        payout_address, payout_chain_id, payout_profile_verified_at, created_at
      ) VALUES (
        '00000000-0000-0000-0000-000000000601', 'competition-1', 'submission-1',
        '00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000101',
        'eligible', 'eligible', 'policy-2026-08', '2026-08-03T12:00:00Z',
        '{"schema_version":"payout-eligibility.v1","policy_version":"policy-2026-08"}'::jsonb, 1, 99.5, 'judge-r7',
        repeat('a', 64), 'scan-r3', '0x52908400098527886E0F7030069857D2E4169EE7', 1,
        '2026-08-02T12:00:00Z', '2026-08-03T12:00:00Z'
      );
    `);
    await expect(db.exec("UPDATE payout_eligibility_freezes SET reason_code = 'tampered' WHERE submission_id = 'submission-1'"))
      .rejects.toThrow(/immutable|freeze/i);
    await expect(db.exec("DELETE FROM payout_eligibility_freezes WHERE submission_id = 'submission-1'"))
      .rejects.toThrow(/immutable|freeze/i);
  });
});
