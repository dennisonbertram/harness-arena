import { createHash, createHmac, timingSafeEqual } from "node:crypto";

type Sql = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};
type Db = Sql & { transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> };

export type PostgresChatActor = { id: string; github_id: number; github_login: string };
type ErrorCode = "unauthenticated" | "forbidden" | "not_found" | "conflict" | "invalid_body" | "invalid_pagination" | "invalid_cursor";
type Failure = { ok: false; error: { code: ErrorCode } };
export type PostgresChatMessage = {
  id: string;
  competition_id: string;
  sequence: number;
  body: string;
  author: { github_id: number; github_login: string };
  reply_to_id?: string;
  mentions: string[];
  unresolved_mentions: string[];
};
type Success = { ok: true; message: PostgresChatMessage };

const maxPage = 100;
const defaultPage = 50;
const fail = (code: ErrorCode): Failure => ({ ok: false, error: { code } });

function handles(body: string): string[] {
  const result = new Set<string>();
  const prose = body.replace(/`[^`]*`/g, " ");
  const pattern = /(^|[^A-Za-z0-9_.])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/g;
  for (const match of prose.matchAll(pattern)) result.add(match[2].toLowerCase());
  return [...result];
}

function requestHash(body: string, replyToId: string | undefined): string {
  return createHash("sha256").update(JSON.stringify([body, replyToId ?? null])).digest("hex");
}

export function createPostgresCompetitionChat(
  db: Db,
  options: { cursorSecret: string; ids: { next(): string }; now(): Date },
) {
  const tails = new Map<string, Promise<void>>();
  const hmac = (value: string) => createHmac("sha256", options.cursorSecret).update(value).digest();
  const roomTag = (competitionId: string) => hmac(`room:${competitionId}`).toString("base64url");
  const cursor = (competitionId: string, after: number) => {
    const payload = Buffer.from(JSON.stringify({ a: after, r: roomTag(competitionId) })).toString("base64url");
    return `chat.v1.${payload}.${hmac(`cursor.v1:${payload}`).toString("base64url")}`;
  };
  const parseCursor = (value: string, competitionId: string): number | null => {
    const match = /^chat\.v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
    if (!match) return null;
    const expected = hmac(`cursor.v1:${match[1]}`).toString("base64url");
    if (expected.length !== match[2].length || !timingSafeEqual(Buffer.from(expected), Buffer.from(match[2]))) return null;
    try {
      const decoded: unknown = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
      const payload = decoded as { a?: unknown; r?: unknown };
      return Number.isSafeInteger(payload.a) && (payload.a as number) >= 0 && payload.r === roomTag(competitionId)
        ? (payload.a as number)
        : null;
    } catch { return null; }
  };
  async function member(competitionId: string, actor: PostgresChatActor | null, sql: Sql = db): Promise<boolean> {
    if (!actor) return false;
    const result = await sql.query<{ ok: number }>(
      "SELECT 1 AS ok FROM competition_memberships WHERE competition_id = $1 AND entrant_id = $2 AND state = 'active'",
      [competitionId, actor.id],
    );
    return result.rows.length === 1;
  }
  async function serialized<T>(competitionId: string, work: () => Promise<T>): Promise<T> {
    const previous = tails.get(competitionId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => tail);
    tails.set(competitionId, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (tails.get(competitionId) === queued) tails.delete(competitionId);
    }
  }
  async function resolveMentions(competitionId: string, values: string[], sql: Sql = db) {
    const resolved: Array<{ id: string; login: string }> = [];
    const unresolved: string[] = [];
    for (const handle of values) {
      const row = await sql.query<{ id: string; github_login: string }>(
        `SELECT e.id, e.github_login FROM entrants e
         JOIN competition_memberships m ON m.entrant_id = e.id
         WHERE m.competition_id = $1 AND m.state = 'active' AND lower(e.github_login) = $2`,
        [competitionId, handle],
      );
      if (row.rows[0]) resolved.push({ id: row.rows[0].id, login: row.rows[0].github_login.toLowerCase() });
      else unresolved.push(handle);
    }
    return { resolved, unresolved };
  }
  async function hydrate(id: string, sql: Sql = db): Promise<PostgresChatMessage | null> {
    const message = await sql.query<{ id: string; competition_id: string; sequence: number; body: string; reply_to_id: string | null; github_id: number; github_login: string }>(
      `SELECT m.id, m.competition_id, m.sequence, m.body, m.reply_to_id, e.github_id, e.github_login
       FROM competition_messages m JOIN entrants e ON e.id = m.author_entrant_id WHERE m.id = $1`, [id],
    );
    const row = message.rows[0];
    if (!row) return null;
    const mentions = await sql.query<{ handle_snapshot: string }>("SELECT handle_snapshot FROM message_mentions WHERE message_id = $1 ORDER BY handle_snapshot", [id]);
    const resolved = mentions.rows.map((value) => value.handle_snapshot.toLowerCase());
    const unresolved_mentions = handles(row.body).filter((value) => !resolved.includes(value));
    return {
      id: row.id, competition_id: row.competition_id, sequence: Number(row.sequence), body: row.body,
      author: { github_id: Number(row.github_id), github_login: row.github_login },
      ...(row.reply_to_id ? { reply_to_id: row.reply_to_id } : {}), mentions: resolved, unresolved_mentions,
    };
  }

  return {
    async post({ actor, competition_id, body, operation_id, reply_to_id }: { actor: PostgresChatActor | null; competition_id: string; body: string; operation_id: string; reply_to_id?: string }) {
      if (!actor) return fail("unauthenticated");
      if (!(await member(competition_id, actor))) return fail("forbidden");
      if (typeof body !== "string" || body.length < 1 || body.length > 4000) return fail("invalid_body");
      return serialized(competition_id, async () => {
        const hash = requestHash(body, reply_to_id);
        const existing = await db.query<{ request_hash: string; entity_id: string | null; response_json: unknown }>(
          `SELECT request_hash, entity_id, response_json FROM idempotency_operations
           WHERE actor_id = $1 AND competition_id = $2 AND operation = 'competition.chat.post' AND idempotency_key = $3`,
          [actor.id, competition_id, operation_id],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== hash) return fail("conflict");
          const stored = existing.rows[0].response_json;
          const replay = typeof stored === "string" ? JSON.parse(stored) : stored;
          return replay as Success;
        }
        try {
          return await db.transaction(async (tx): Promise<Success | Failure> => {
            if (!(await member(competition_id, actor, tx))) return fail("forbidden");
            const concurrent = await tx.query<{ request_hash: string; entity_id: string | null; response_json: unknown }>(
              `SELECT request_hash, entity_id, response_json FROM idempotency_operations
               WHERE actor_id = $1 AND competition_id = $2 AND operation = 'competition.chat.post' AND idempotency_key = $3`,
              [actor.id, competition_id, operation_id],
            );
            if (concurrent.rows[0]) {
              if (concurrent.rows[0].request_hash !== hash) return fail("conflict");
              const stored = concurrent.rows[0].response_json;
              const replay = typeof stored === "string" ? JSON.parse(stored) : stored;
              return replay as Success;
            }
            if (reply_to_id) {
              const parent = await tx.query<{ id: string }>("SELECT id FROM competition_messages WHERE id = $1 AND competition_id = $2", [reply_to_id, competition_id]);
              if (!parent.rows[0]) return fail("not_found");
            }
            await tx.query(
              `INSERT INTO competition_chat_sequences (competition_id, next_sequence, updated_at)
               VALUES ($1, 1, $2::timestamptz)
               ON CONFLICT (competition_id) DO NOTHING`,
              [competition_id, options.now().toISOString()],
            );
            const next = await tx.query<{ sequence: number }>(
              `UPDATE competition_chat_sequences
               SET next_sequence = next_sequence + 1, updated_at = $2::timestamptz
               WHERE competition_id = $1
               RETURNING next_sequence - 1 AS sequence`,
              [competition_id, options.now().toISOString()],
            );
            const messageId = options.ids.next();
            const operationId = options.ids.next();
            const outboxId = options.ids.next();
            const mention = await resolveMentions(competition_id, handles(body), tx);
            const createdAt = options.now().toISOString();
            await tx.query(
              `INSERT INTO competition_messages (id, competition_id, sequence, author_entrant_id, reply_to_id, body, body_format, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,'plain',$7)`,
              [messageId, competition_id, next.rows[0].sequence, actor.id, reply_to_id ?? null, body, createdAt],
            );
            for (const target of mention.resolved) await tx.query(
              "INSERT INTO message_mentions (message_id, target_entrant_id, handle_snapshot) VALUES ($1,$2,$3)", [messageId, target.id, target.login],
            );
            const message = await hydrate(messageId, tx);
            if (!message) throw new Error("message insert disappeared");
            const response: Success = { ok: true, message };
            await tx.query(
              `INSERT INTO idempotency_operations (id, actor_id, competition_id, operation, idempotency_key, request_hash, entity_id, response_json, state, created_at, updated_at, completed_at)
               VALUES ($1,$2,$3,'competition.chat.post',$4,$5,$6,$7::jsonb,'completed',$8,$8,$8)`,
              [operationId, actor.id, competition_id, operation_id, hash, messageId, JSON.stringify(response), createdAt],
            );
            await tx.query(
              `INSERT INTO domain_outbox (id, operation_id, topic, payload_version, safe_payload, state, created_at)
               VALUES ($1,$2,'competition.message.created',1,$3::jsonb,'pending',$4)`,
              [outboxId, operationId, JSON.stringify({ message_id: messageId, competition_id }), createdAt],
            );
            return response;
          });
        } catch (error) {
          const replay = await db.query<{ request_hash: string; response_json: unknown }>(
            `SELECT request_hash, response_json FROM idempotency_operations
             WHERE actor_id = $1 AND competition_id = $2 AND operation = 'competition.chat.post' AND idempotency_key = $3`,
            [actor.id, competition_id, operation_id],
          );
          if (replay.rows[0]?.request_hash === hash) {
            const stored = replay.rows[0].response_json;
            return (typeof stored === "string" ? JSON.parse(stored) : stored) as Success;
          }
          throw error;
        }
      });
    },
    async list({ actor, competition_id, cursor: inputCursor, limit = defaultPage }: { actor: PostgresChatActor | null; competition_id: string; cursor?: string | null; limit?: number }) {
      if (!actor) return fail("unauthenticated");
      if (!(await member(competition_id, actor))) return fail("forbidden");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxPage) return fail("invalid_pagination");
      const after = inputCursor ? parseCursor(inputCursor, competition_id) : 0;
      if (after === null) return fail("invalid_cursor");
      const watermark = await db.query<{ value: number }>("SELECT COALESCE(MAX(sequence), 0) AS value FROM competition_messages WHERE competition_id = $1", [competition_id]);
      const rows = await db.query<{ id: string }>(
        "SELECT id FROM competition_messages WHERE competition_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3", [competition_id, after, limit + 1],
      );
      const has_more = rows.rows.length > limit;
      const visible = rows.rows.slice(0, limit);
      const messages = (await Promise.all(visible.map((row) => hydrate(row.id)))).filter((value): value is PostgresChatMessage => value !== null);
      return { ok: true as const, page: { messages, next_cursor: messages.length ? cursor(competition_id, messages[messages.length - 1].sequence) : inputCursor ?? null, has_more, high_water_mark: Number(watermark.rows[0].value) } };
    },
  };
}
