import { describe, expect, it } from "vitest";
import { createCompetitionChatCore } from "./core";

const ALICE = { github_id: 101, github_login: "alice" };
const BOB = { github_id: 202, github_login: "bob" };
const CAROL = { github_id: 303, github_login: "carol" };

function member(chat: ReturnType<typeof createCompetitionChatCore>, competition_id: string, actor: typeof ALICE) {
  chat.grantMembership({ competition_id, ...actor });
}

async function post(
  chat: ReturnType<typeof createCompetitionChatCore>,
  actor: typeof ALICE | typeof BOB | typeof CAROL | null,
  competition_id: string,
  body: string,
  operation_id: string,
  reply_to_id?: string,
) {
  return chat.post({ actor, competition_id, body, operation_id, reply_to_id });
}

describe("competition chat core", () => {
  it("allows only authenticated competition members to read and post", async () => {
    const chat = createCompetitionChatCore();
    member(chat, "comp-a", ALICE);

    await expect(post(chat, null, "comp-a", "hello", "op-anon")).resolves.toEqual({
      ok: false,
      error: { code: "unauthenticated" },
    });
    await expect(post(chat, BOB, "comp-a", "hello", "op-outsider")).resolves.toEqual({
      ok: false,
      error: { code: "forbidden" },
    });
    await expect(chat.list({ actor: null, competition_id: "comp-a" })).resolves.toEqual({
      ok: false,
      error: { code: "unauthenticated" },
    });
    await expect(chat.list({ actor: BOB, competition_id: "comp-a" })).resolves.toEqual({
      ok: false,
      error: { code: "forbidden" },
    });

    await expect(post(chat, ALICE, "comp-a", "member message", "op-member")).resolves.toMatchObject({
      ok: true,
      message: { competition_id: "comp-a", sequence: 1, author: { github_id: 101, github_login: "alice" } },
    });
  });

  it("applies membership revocation immediately to reads and writes", async () => {
    const chat = createCompetitionChatCore();
    member(chat, "comp-a", ALICE);
    await post(chat, ALICE, "comp-a", "before revoke", "op-before");

    chat.revokeMembership({ competition_id: "comp-a", github_id: ALICE.github_id });

    await expect(chat.list({ actor: ALICE, competition_id: "comp-a" })).resolves.toEqual({
      ok: false,
      error: { code: "forbidden" },
    });
    await expect(post(chat, ALICE, "comp-a", "after revoke", "op-after")).resolves.toEqual({
      ok: false,
      error: { code: "forbidden" },
    });
  });

  it("assigns one monotonic sequence per competition and never leaks messages across competitions", async () => {
    const chat = createCompetitionChatCore();
    member(chat, "comp-a", ALICE);
    member(chat, "comp-a", BOB);
    member(chat, "comp-b", ALICE);
    member(chat, "comp-b", CAROL);

    await post(chat, ALICE, "comp-a", "a1", "op-a1");
    await post(chat, BOB, "comp-a", "a2", "op-a2");
    await post(chat, ALICE, "comp-b", "b1", "op-b1");

    await expect(chat.list({ actor: ALICE, competition_id: "comp-a" })).resolves.toMatchObject({
      ok: true,
      page: { messages: [{ sequence: 1, body: "a1" }, { sequence: 2, body: "a2" }] },
    });
    await expect(chat.list({ actor: ALICE, competition_id: "comp-b" })).resolves.toMatchObject({
      ok: true,
      page: { messages: [{ sequence: 1, body: "b1" }] },
    });
  });

  it("returns cursor pages in sequence order with a versioned opaque next_cursor, high-water mark, and has_more", async () => {
    const chat = createCompetitionChatCore();
    member(chat, "comp-a", ALICE);
    for (const sequence of [1, 2, 3]) {
      await post(chat, ALICE, "comp-a", `message ${sequence}`, `op-page-${sequence}`);
    }

    const first = await chat.list({ actor: ALICE, competition_id: "comp-a", limit: 2 });
    if (!first.ok) throw new Error("fixture list failed");
    expect(first.page).toMatchObject({
      messages: [
        expect.objectContaining({ sequence: 1, body: "message 1" }),
        expect.objectContaining({ sequence: 2, body: "message 2" }),
      ],
      high_water_mark: 3,
      has_more: true,
    });
    expect(first.page.next_cursor).toMatch(/^chat\.v1\./);
    expect(first.page.next_cursor).not.toContain("comp-a");

    const second = await chat.list({ actor: ALICE, competition_id: "comp-a", cursor: first.page.next_cursor, limit: 2 });
    if (!second.ok) throw new Error("fixture list failed");
    expect(second.page).toMatchObject({
      messages: [expect.objectContaining({ sequence: 3, body: "message 3" })],
      high_water_mark: 3,
      has_more: false,
    });
    expect(second.page.next_cursor).toMatch(/^chat\.v1\./);
    expect(second.page.next_cursor).not.toBe(first.page.next_cursor);

    await expect(chat.list({ actor: ALICE, competition_id: "comp-a", cursor: second.page.next_cursor, limit: 2 }))
      .resolves.toMatchObject({
        ok: true,
        page: { messages: [], next_cursor: second.page.next_cursor, high_water_mark: 3, has_more: false },
      });

    await post(chat, ALICE, "comp-a", "message 4", "op-page-4");
    await expect(chat.list({ actor: ALICE, competition_id: "comp-a", cursor: second.page.next_cursor, limit: 2 }))
      .resolves.toMatchObject({
        ok: true,
        page: {
          messages: [expect.objectContaining({ sequence: 4, body: "message 4" })],
          high_water_mark: 4,
          has_more: false,
        },
      });
  });

  it("rejects malformed cursors and cursors bound to another competition", async () => {
    const chat = createCompetitionChatCore();
    member(chat, "comp-a", ALICE);
    member(chat, "comp-b", ALICE);
    await post(chat, ALICE, "comp-a", "a1", "op-a1");
    const page = await chat.list({ actor: ALICE, competition_id: "comp-a", limit: 1 });
    if (!page.ok) throw new Error("fixture list failed");

    await expect(chat.list({ actor: ALICE, competition_id: "comp-a", cursor: "1" })).resolves.toEqual({
      ok: false,
      error: { code: "invalid_cursor" },
    });
    await expect(chat.list({ actor: ALICE, competition_id: "comp-b", cursor: page.page.next_cursor })).resolves.toEqual({
      ok: false,
      error: { code: "invalid_cursor" },
    });
  });

  it("requires a reply target to exist in the same competition without exposing another competition's message", async () => {
    const chat = createCompetitionChatCore();
    member(chat, "comp-a", ALICE);
    member(chat, "comp-b", ALICE);
    const original = await post(chat, ALICE, "comp-a", "a root", "op-root");
    if (!original.ok) throw new Error("fixture post failed");

    await expect(post(chat, ALICE, "comp-b", "cross competition reply", "op-cross", original.message.id)).resolves.toEqual({
      ok: false,
      error: { code: "not_found" },
    });
    await expect(post(chat, ALICE, "comp-a", "same competition reply", "op-same", original.message.id)).resolves.toMatchObject({
      ok: true,
      message: { reply_to_id: original.message.id },
    });
  });

  it("extracts case-insensitive unique GitHub handles while ignoring email and inline-code false positives", async () => {
    const chat = createCompetitionChatCore();
    member(chat, "comp-a", ALICE);

    const result = await post(
      chat,
      ALICE,
      "comp-a",
      "Thanks @Octo-Cat and @octo-cat. Email dev@example.com; do not parse `@code_handle`. Ping @valid-user.",
      "op-mentions",
    );

    expect(result).toMatchObject({ ok: true, message: { mentions: ["octo-cat", "valid-user"] } });
  });

  it("makes an operation retry return its original message and conflicts if its body changes", async () => {
    const chat = createCompetitionChatCore();
    member(chat, "comp-a", ALICE);

    const first = await post(chat, ALICE, "comp-a", "original", "op-idempotent");
    const retry = await post(chat, ALICE, "comp-a", "original", "op-idempotent");
    const changed = await post(chat, ALICE, "comp-a", "changed", "op-idempotent");

    expect(first).toEqual(retry);
    expect(changed).toEqual({ ok: false, error: { code: "conflict" } });
  });

  it("serializes concurrent posts so sequences are unique and contiguous", async () => {
    const chat = createCompetitionChatCore();
    member(chat, "comp-a", ALICE);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => post(chat, ALICE, "comp-a", `concurrent ${index}`, `op-concurrent-${index}`)),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    const page = await chat.list({ actor: ALICE, competition_id: "comp-a", limit: 20 });
    if (!page.ok) throw new Error("fixture list failed");
    expect(page.page.messages.map((message) => message.sequence)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
  });

  it("bounds bodies and pagination, and never returns secret or private-trace DTO fields", async () => {
    const chat = createCompetitionChatCore();
    member(chat, "comp-a", ALICE);

    await expect(post(chat, ALICE, "comp-a", "x".repeat(4_001), "op-large")).resolves.toEqual({
      ok: false,
      error: { code: "invalid_body" },
    });
    await expect(chat.list({ actor: ALICE, competition_id: "comp-a", limit: 101 })).resolves.toEqual({
      ok: false,
      error: { code: "invalid_pagination" },
    });

    const result = await post(chat, ALICE, "comp-a", "safe public message", "op-dto");
    if (!result.ok) throw new Error("fixture post failed");
    for (const forbidden of ["github_token", "token", "private_trace", "trace", "prompt"] as const) {
      expect(result.message).not.toHaveProperty(forbidden);
    }
  });
});
