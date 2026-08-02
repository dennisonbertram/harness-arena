import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresCompetitionChat } from "./postgres";

const migration = (name: string) => readFileSync(path.join(process.cwd(), "db", "migrations", name), "utf8");
const ALICE = { id: "00000000-0000-0000-0000-000000000101", github_id: 101, github_login: "alice" };
const BOB = { id: "00000000-0000-0000-0000-000000000202", github_id: 202, github_login: "bob" };
const CAROL = { id: "00000000-0000-0000-0000-000000000303", github_id: 303, github_login: "carol" };

let db: PGlite;
let id = 400;

beforeEach(async () => {
  db = await PGlite.create();
  await db.exec(migration("0001_agent_network.sql"));
  await db.exec(migration("0002_competition_chat.sql"));
  id = 400;
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

async function seed(...entrants: Array<typeof ALICE>) {
  for (const entrant of entrants) {
    await db.exec(
      `INSERT INTO entrants (id, github_id, github_login)
       VALUES ('${entrant.id}', ${entrant.github_id}, '${entrant.github_login}')`,
    );
  }
}

async function active(competition_id: string, entrant: typeof ALICE, state = "active") {
  await db.exec(
    `INSERT INTO competition_memberships (competition_id, entrant_id, state)
     VALUES ('${competition_id}', '${entrant.id}', '${state}')`,
  );
}

async function post(
  client: ReturnType<typeof createPostgresCompetitionChat>,
  actor: typeof ALICE | typeof BOB | typeof CAROL | null,
  competition_id: string,
  body: string,
  operation_id: string,
  reply_to_id?: string,
) {
  return client.post({ actor, competition_id, body, operation_id, reply_to_id });
}

describe("0002 durable competition chat", () => {
  it("is a repeatable transactional migration with only chat messages and mentions", async () => {
    await db.exec(migration("0002_competition_chat.sql"));
    const tables = await db.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(["competition_messages", "message_mentions"]),
    );
    expect(migration("0002_competition_chat.sql")).toMatch(/^\s*BEGIN\s*;/i);
    expect(migration("0002_competition_chat.sql")).toMatch(/COMMIT\s*;\s*$/i);
  });

  it("enforces per-room sequence, same-room reply, body bounds, and no sensitive message columns", async () => {
    const constraints = await db.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      WHERE c.conrelid = 'competition_messages'::regclass
    `);
    expect(constraints.rows.map((row) => row.definition).join(" ")).toMatch(/UNIQUE.*competition_id.*sequence/i);
    expect(constraints.rows.map((row) => row.definition).join(" ")).toMatch(/FOREIGN KEY.*competition_messages.*competition_id/i);

    const columns = await db.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'competition_messages'
    `);
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual(expect.arrayContaining([
      "id",
      "competition_id",
      "sequence",
      "author_entrant_id",
      "reply_to_id",
      "body",
      "body_format",
      "created_at",
    ]));
    for (const { column_name } of columns.rows) expect(column_name).not.toMatch(/prompt|token|trace/i);

    const mentionColumns = await db.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'message_mentions'
    `);
    expect(mentionColumns.rows.map(({ column_name }) => column_name)).toEqual(expect.arrayContaining([
      "message_id",
      "target_entrant_id",
      "handle_snapshot",
    ]));

    await seed(ALICE);
    await active("comp-a", ALICE);
    await expect(db.exec(`
      INSERT INTO competition_messages (
        id, competition_id, sequence, author_entrant_id, body, body_format
      ) VALUES (
        '00000000-0000-0000-0000-000000000901', 'comp-a', 1, '${ALICE.id}', repeat('x', 4001), 'plain'
      )
    `)).rejects.toThrow();
  });

  it("authorizes only active members and observes revocation immediately", async () => {
    await seed(ALICE, BOB);
    await active("comp-a", ALICE);
    const client = chat();

    await expect(post(client, null, "comp-a", "hi", "op-null")).resolves.toEqual({ ok: false, error: { code: "unauthenticated" } });
    await expect(post(client, BOB, "comp-a", "hi", "op-outsider")).resolves.toEqual({ ok: false, error: { code: "forbidden" } });
    await expect(post(client, ALICE, "comp-a", "hi", "op-member")).resolves.toMatchObject({ ok: true, message: { sequence: 1 } });

    await db.exec(`UPDATE competition_memberships SET state = 'banned' WHERE competition_id = 'comp-a' AND entrant_id = '${ALICE.id}'`);
    await expect(client.list({ actor: ALICE, competition_id: "comp-a" })).resolves.toEqual({ ok: false, error: { code: "forbidden" } });
  });

  it("is idempotent, resolves active mentions only, and refuses cross-room replies", async () => {
    await seed(ALICE, BOB, CAROL);
    await active("comp-a", ALICE);
    await active("comp-a", BOB);
    await active("comp-b", ALICE);
    await active("comp-b", CAROL, "left");
    const client = chat();

    const first = await post(client, ALICE, "comp-a", "Ping @Bob, @bob, @carol and @missing.", "op-once");
    if (!first.ok) throw new Error("fixture post failed");
    expect(first.message).toMatchObject({ mentions: ["bob"], unresolved_mentions: ["carol", "missing"] });
    expect(await post(client, ALICE, "comp-a", "Ping @Bob, @bob, @carol and @missing.", "op-once")).toEqual(first);
    await expect(post(client, ALICE, "comp-a", "changed", "op-once")).resolves.toEqual({ ok: false, error: { code: "conflict" } });
    await expect(post(client, ALICE, "comp-b", "wrong room", "op-reply", first.message.id)).resolves.toEqual({ ok: false, error: { code: "not_found" } });
  });

  it("uses signed opaque exclusive-after cursors with live high-water marks and contiguous concurrent sequences", async () => {
    await seed(ALICE);
    await active("comp-a", ALICE);
    await active("other", ALICE);
    const client = chat();
    await Promise.all(Array.from({ length: 3 }, (_, index) => post(client, ALICE, "comp-a", `m${index}`, `op-${index}`)));

    const first = await client.list({ actor: ALICE, competition_id: "comp-a", limit: 2 });
    if (!first.ok) throw new Error("fixture list failed");
    expect(first.page).toMatchObject({ high_water_mark: 3, has_more: true });
    expect(first.page.messages.map((message) => message.sequence)).toEqual([1, 2]);
    expect(first.page.next_cursor).toMatch(/^chat\.v1\./);
    expect(first.page.next_cursor).not.toContain("comp-a");

    const exhausted = await client.list({ actor: ALICE, competition_id: "comp-a", cursor: first.page.next_cursor, limit: 2 });
    if (!exhausted.ok) throw new Error("fixture list failed");
    expect(exhausted.page.messages.map((message) => message.sequence)).toEqual([3]);
    const empty = await client.list({ actor: ALICE, competition_id: "comp-a", cursor: exhausted.page.next_cursor, limit: 2 });
    expect(empty).toMatchObject({ ok: true, page: { messages: [], next_cursor: exhausted.page.next_cursor } });

    await post(client, ALICE, "comp-a", "later", "op-later");
    await expect(client.list({ actor: ALICE, competition_id: "comp-a", cursor: exhausted.page.next_cursor, limit: 2 })).resolves.toMatchObject({
      ok: true,
      page: { messages: [expect.objectContaining({ sequence: 4 })], high_water_mark: 4 },
    });
    await expect(client.list({ actor: ALICE, competition_id: "other", cursor: first.page.next_cursor })).resolves.toEqual({ ok: false, error: { code: "invalid_cursor" } });
  });

  it("returns explicit public DTOs only", async () => {
    await seed(ALICE);
    await active("comp-a", ALICE);
    const result = await post(chat(), ALICE, "comp-a", "public", "op-dto");
    if (!result.ok) throw new Error("fixture post failed");
    for (const field of ["prompt", "token", "trace", "github_token", "operation_id"] as const) {
      expect(result.message).not.toHaveProperty(field);
    }
  });
});
