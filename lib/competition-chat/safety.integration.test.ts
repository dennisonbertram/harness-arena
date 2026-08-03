import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPostgresCompetitionChat, type PostgresChatActor } from "./postgres";

const migration = (name: string) => readFileSync(path.join(process.cwd(), "db", "migrations", name), "utf8");
const ALICE = { id: "00000000-0000-0000-0000-000000000101", github_id: 101, github_login: "alice" };
const BOB = { id: "00000000-0000-0000-0000-000000000202", github_id: 202, github_login: "bob" };
const OPERATOR = { ...ALICE, role: "operator" as const };

type SafetyChat = {
  join(input: { actor: PostgresChatActor; competition_id: string }): Promise<unknown>;
  subscribe(input: { actor: PostgresChatActor; competition_id: string }): Promise<unknown>;
  ban(input: { actor: PostgresChatActor & { role?: string }; competition_id: string; entrant_id: string; operation_id: string }): Promise<unknown>;
  tombstone(input: { actor: PostgresChatActor & { role?: string }; competition_id: string; message_id: string; operation_id: string }): Promise<unknown>;
  post(input: { actor: PostgresChatActor | null; competition_id: string; body: string; operation_id: string; reply_to_id?: string }): Promise<any>;
  list(input: { actor: PostgresChatActor | null; competition_id: string }): Promise<any>;
};

let db: PGlite;
let serial = 900;

beforeEach(async () => {
  db = await PGlite.create();
  for (const name of [
    "0001_agent_network.sql",
    "0002_competition_chat.sql",
    "0005_competition_chat_sequences.sql",
    "0009_chat_safety.sql",
  ]) await db.exec(migration(name));
  serial = 900;
  await db.exec(`
    INSERT INTO entrants (id, github_id, github_login) VALUES
      ('${ALICE.id}', ${ALICE.github_id}, '${ALICE.github_login}'),
      ('${BOB.id}', ${BOB.github_id}, '${BOB.github_login}');
    INSERT INTO competition_memberships (competition_id, entrant_id, state) VALUES
      ('comp-a', '${ALICE.id}', 'active'), ('comp-a', '${BOB.id}', 'active');
  `);
});

afterEach(async () => { await db.close(); });

function chat(): SafetyChat {
  return createPostgresCompetitionChat(db, {
    cursorSecret: "safety-test-cursor-secret",
    ids: { next: () => `00000000-0000-0000-0000-${String(serial++).padStart(12, "0")}` },
    now: () => new Date("2026-08-03T12:00:00.000Z"),
    quotas: { posts: { limit: 2, windowMs: 60_000 } },
  } as never) as unknown as SafetyChat;
}

describe("0009 durable competition-chat safety", () => {
  it("holds a durable entrant+competition quota inside the post transaction, so concurrent posts cannot exceed it", async () => {
    const client = chat();
    const results = await Promise.all(["one", "two", "three"].map((body, index) => client.post({
      actor: ALICE, competition_id: "comp-a", body, operation_id: `quota-${index}`,
    })));
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: { code: "rate_limited" } }]);
    await expect(db.query(`SELECT used FROM competition_chat_quotas WHERE competition_id='comp-a' AND entrant_id='${ALICE.id}'`))
      .resolves.toMatchObject({ rows: [{ used: 2 }] });
  });

  it("makes left/banned membership immediate for join, read, write, and subscribe, and join never reactivates a ban", async () => {
    const client = chat();
    await db.exec(`UPDATE competition_memberships SET state='left' WHERE competition_id='comp-a' AND entrant_id='${BOB.id}'`);
    for (const call of [
      () => client.join({ actor: BOB, competition_id: "comp-a" }),
      () => client.list({ actor: BOB, competition_id: "comp-a" }),
      () => client.post({ actor: BOB, competition_id: "comp-a", body: "blocked", operation_id: "left-post" }),
      () => client.subscribe({ actor: BOB, competition_id: "comp-a" }),
    ]) await expect(call()).resolves.toEqual({ ok: false, error: { code: "forbidden" } });

    await expect(client.ban({ actor: OPERATOR, competition_id: "comp-a", entrant_id: BOB.id, operation_id: "ban-bob" }))
      .resolves.toEqual({ ok: true });
    await expect(client.join({ actor: BOB, competition_id: "comp-a" })).resolves.toEqual({ ok: false, error: { code: "forbidden" } });
    await expect(db.query(`SELECT state FROM competition_memberships WHERE competition_id='comp-a' AND entrant_id='${BOB.id}'`))
      .resolves.toMatchObject({ rows: [{ state: "banned" }] });
  });

  it("allows only operators to ban/tombstone, records append-only audit entries, and preserves tombstone sequence, reply, and audit linkage", async () => {
    const client = chat();
    const posted = await client.post({ actor: BOB, competition_id: "comp-a", body: "<b>Hello</b> **@alice**", operation_id: "post-tombstone" });
    if (!posted.ok) throw new Error("fixture post failed");
    await expect(client.ban({ actor: BOB, competition_id: "comp-a", entrant_id: ALICE.id, operation_id: "not-operator" }))
      .resolves.toEqual({ ok: false, error: { code: "forbidden" } });
    await expect(client.tombstone({ actor: BOB, competition_id: "comp-a", message_id: posted.message.id, operation_id: "not-operator" }))
      .resolves.toEqual({ ok: false, error: { code: "forbidden" } });
    await expect(client.tombstone({ actor: OPERATOR, competition_id: "comp-a", message_id: posted.message.id, operation_id: "tombstone-1" }))
      .resolves.toEqual({ ok: true });

    const listed = await client.list({ actor: ALICE, competition_id: "comp-a" });
    expect(listed).toMatchObject({ ok: true, page: { messages: [expect.objectContaining({ id: posted.message.id, sequence: posted.message.sequence, body: "[message removed]" })] } });
    await expect(db.query(`UPDATE competition_chat_audit_events SET action='mutated'`)).rejects.toThrow();
    await expect(db.query("SELECT action, message_id FROM competition_chat_audit_events WHERE message_id=$1", [posted.message.id]))
      .resolves.toMatchObject({ rows: [expect.objectContaining({ action: "message.tombstoned", message_id: posted.message.id })] });
  });

  it("projects plain text safely while preserving mention text, and resolves active immutable entrant IDs in the posting transaction", async () => {
    const client = chat();
    const message = await client.post({ actor: BOB, competition_id: "comp-a", body: "<img src=x> **@Alice**", operation_id: "plain-text" });
    if (!message.ok) throw new Error("fixture post failed");
    expect(message.message.body).toBe("&lt;img src=x&gt; **@Alice**");
    expect(message.message.mentions).toEqual(["alice"]);
    await expect(db.query("SELECT target_entrant_id, handle_snapshot FROM message_mentions WHERE message_id=$1", [message.message.id]))
      .resolves.toMatchObject({ rows: [{ target_entrant_id: ALICE.id, handle_snapshot: "alice" }] });
    await expect(db.query("UPDATE message_mentions SET target_entrant_id=$1 WHERE message_id=$2", [BOB.id, message.message.id])).rejects.toThrow();
  });

  it("fails closed when a ban races a queued post", async () => {
    const client = chat();
    const ban = client.ban({ actor: OPERATOR, competition_id: "comp-a", entrant_id: BOB.id, operation_id: "ban-race" });
    const post = client.post({ actor: BOB, competition_id: "comp-a", body: "must not appear", operation_id: "post-race" });
    await ban;
    await expect(post).resolves.toEqual({ ok: false, error: { code: "forbidden" } });
  });

  it("fails closed for invalid quota configuration and unauthenticated moderation", async () => {
    const invalidQuota = createPostgresCompetitionChat(db, {
      cursorSecret: "safety-test-cursor-secret",
      ids: { next: () => `00000000-0000-0000-0000-${String(serial++).padStart(12, "0")}` },
      now: () => new Date("2026-08-03T12:00:00.000Z"),
      quotas: { posts: { limit: 0, windowMs: 60_000 } },
    });
    await expect(invalidQuota.post({ actor: ALICE, competition_id: "comp-a", body: "blocked", operation_id: "invalid-quota" }))
      .resolves.toEqual({ ok: false, error: { code: "rate_limited" } });

    const client = chat() as any;
    await expect(client.ban({ actor: null, competition_id: "comp-a", entrant_id: BOB.id, operation_id: "anonymous-ban" }))
      .resolves.toEqual({ ok: false, error: { code: "unauthenticated" } });
    await expect(client.tombstone({ actor: null, competition_id: "comp-a", message_id: "missing", operation_id: "anonymous-tombstone" }))
      .resolves.toEqual({ ok: false, error: { code: "unauthenticated" } });
  });

  it("makes moderation idempotent and reports missing or ineligible moderation targets", async () => {
    const client = chat();
    await expect(client.ban({ actor: OPERATOR, competition_id: "comp-a", entrant_id: BOB.id, operation_id: "ban-idempotent" }))
      .resolves.toEqual({ ok: true });
    await expect(client.ban({ actor: OPERATOR, competition_id: "comp-a", entrant_id: BOB.id, operation_id: "ban-idempotent" }))
      .resolves.toEqual({ ok: true });
    await expect(client.ban({ actor: OPERATOR, competition_id: "comp-a", entrant_id: "00000000-0000-0000-0000-000000000999", operation_id: "ban-missing" }))
      .resolves.toEqual({ ok: false, error: { code: "not_found" } });

    await db.exec(`UPDATE competition_memberships SET state='left' WHERE competition_id='comp-a' AND entrant_id='${ALICE.id}'`);
    await expect(client.ban({ actor: OPERATOR, competition_id: "comp-a", entrant_id: BOB.id, operation_id: "operator-left" }))
      .resolves.toEqual({ ok: false, error: { code: "forbidden" } });
    await db.exec(`UPDATE competition_memberships SET state='active' WHERE competition_id='comp-a' AND entrant_id='${ALICE.id}'`);

    await expect(client.tombstone({ actor: OPERATOR, competition_id: "comp-a", message_id: "00000000-0000-0000-0000-000000000999", operation_id: "missing-message" }))
      .resolves.toEqual({ ok: false, error: { code: "not_found" } });
    const posted = await client.post({ actor: ALICE, competition_id: "comp-a", body: "remove me", operation_id: "post-for-repeat-tombstone" });
    if (!posted.ok) throw new Error("fixture post failed");
    await expect(client.tombstone({ actor: OPERATOR, competition_id: "comp-a", message_id: posted.message.id, operation_id: "tombstone-idempotent" }))
      .resolves.toEqual({ ok: true });
    await expect(client.tombstone({ actor: OPERATOR, competition_id: "comp-a", message_id: posted.message.id, operation_id: "tombstone-idempotent" }))
      .resolves.toEqual({ ok: true });
  });
});
