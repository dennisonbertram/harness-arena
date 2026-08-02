import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresCompetitionChat } from "./postgres";

const migration = (name: string) => readFileSync(path.join(process.cwd(), "db", "migrations", name), "utf8");
const ALICE = { id: "00000000-0000-0000-0000-000000000101", github_id: 101, github_login: "alice" };
let db: PGlite;
let id: number;

beforeEach(async () => {
  db = await PGlite.create();
  await db.exec(migration("0001_agent_network.sql"));
  await db.exec(migration("0002_competition_chat.sql"));
  await db.exec(migration("0005_competition_chat_sequences.sql"));
  await db.exec(`
    INSERT INTO entrants (id, github_id, github_login)
    VALUES ('${ALICE.id}', ${ALICE.github_id}, '${ALICE.github_login}');
    INSERT INTO competition_memberships (competition_id, entrant_id, state)
    VALUES ('comp-a', '${ALICE.id}', 'active');
  `);
  id = 700;
});

afterEach(async () => {
  await db.close();
});

function chat() {
  return createPostgresCompetitionChat(db, {
    cursorSecret: "test-only-32-byte-cursor-secret-value",
    ids: { next: () => `00000000-0000-0000-0000-${String(id++).padStart(12, "0")}` },
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  });
}

describe("database-owned competition chat sequencing", () => {
  it("ships a repeatable counter-only migration without participant content", async () => {
    await db.exec(migration("0005_competition_chat_sequences.sql"));
    const columns = await db.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'competition_chat_sequences'
      ORDER BY ordinal_position
    `);
    expect(columns.rows.map((row) => row.column_name)).toEqual(["competition_id", "next_sequence", "updated_at"]);
    expect(migration("0005_competition_chat_sequences.sql")).not.toMatch(/body|prompt|trace|token/i);
    await expect(db.query("SELECT version FROM schema_migrations WHERE version = '0005_competition_chat_sequences'"))
      .resolves.toMatchObject({ rows: [{ version: "0005_competition_chat_sequences" }] });
  });

  it("uses the database counter across independently constructed service instances", async () => {
    const first = chat();
    const second = chat();
    const results = [];
    for (let index = 0; index < 12; index += 1) {
      results.push(await (index % 2 === 0 ? first : second).post({
        actor: ALICE,
        competition_id: "comp-a",
        body: `message-${index}`,
        operation_id: `operation-${index}`,
      }));
    }
    expect(results.every((result) => result.ok)).toBe(true);
    const persisted = await db.query<{ sequence: number }>(
      "SELECT sequence FROM competition_messages WHERE competition_id = 'comp-a' ORDER BY sequence",
    );
    expect(persisted.rows.map((row) => Number(row.sequence))).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    await expect(db.query<{ next_sequence: number }>(
      "SELECT next_sequence FROM competition_chat_sequences WHERE competition_id = 'comp-a'",
    )).resolves.toMatchObject({ rows: [{ next_sequence: 13 }] });
  });
});
