import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type ChatActor = { github_id: number; github_login: string };

export type ChatMessage = {
  id: string;
  competition_id: string;
  sequence: number;
  body: string;
  author: ChatActor;
  reply_to_id?: string;
  mentions: string[];
};

type ChatErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_body"
  | "invalid_pagination"
  | "invalid_cursor";

type Failure = { ok: false; error: { code: ChatErrorCode } };
type PostSuccess = { ok: true; message: ChatMessage };
type ListSuccess = {
  ok: true;
  page: { messages: ChatMessage[]; next_cursor: string | null; has_more: boolean; high_water_mark: number };
};

export type CompetitionChatCore = {
  grantMembership(member: { competition_id: string } & ChatActor): void;
  revokeMembership(member: { competition_id: string; github_id: number }): void;
  post(request: {
    actor: ChatActor | null;
    competition_id: string;
    body: string;
    operation_id: string;
    reply_to_id?: string;
  }): Promise<PostSuccess | Failure>;
  list(request: {
    actor: ChatActor | null;
    competition_id: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<ListSuccess | Failure>;
};

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_BODY_LENGTH = 4_000;

function failure(code: ChatErrorCode): Failure {
  return { ok: false, error: { code } };
}

function operationKey(competitionId: string, actorId: number, operationId: string): string {
  return `${competitionId}\u0000${actorId}\u0000${operationId}`;
}

function canonicalOperation(body: string, replyToId: string | undefined): string {
  return JSON.stringify([body, replyToId ?? null]);
}

function mentionsIn(body: string): string[] {
  // Inline code is not conversational text. Remove it before scanning so
  // examples such as `@placeholder` cannot notify a GitHub account.
  const prose = body.replace(/`[^`]*`/g, " ");
  const mentions = new Set<string>();
  const pattern = /(^|[^A-Za-z0-9_.])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/g;
  for (const match of prose.matchAll(pattern)) mentions.add(match[2].toLowerCase());
  return [...mentions];
}

function cloneMessage(message: ChatMessage): ChatMessage {
  // The explicit allowlist is intentional: chat DTOs must never accrete
  // auth secrets, private traces, prompts, or persistence-only fields.
  return {
    id: message.id,
    competition_id: message.competition_id,
    sequence: message.sequence,
    body: message.body,
    author: { github_id: message.author.github_id, github_login: message.author.github_login },
    ...(message.reply_to_id === undefined ? {} : { reply_to_id: message.reply_to_id }),
    mentions: [...message.mentions],
  };
}

export function createCompetitionChatCore(): CompetitionChatCore {
  const members = new Map<string, Map<number, ChatActor>>();
  const messages = new Map<string, ChatMessage[]>();
  const operations = new Map<string, { canonical: string; message: ChatMessage }>();
  const tails = new Map<string, Promise<void>>();
  const cursorSecret = randomBytes(32);
  let messageSerial = 0;

  function isMember(competitionId: string, actor: ChatActor | null): boolean {
    return actor !== null && members.get(competitionId)?.has(actor.github_id) === true;
  }

  function hmac(value: string): Buffer {
    return createHmac("sha256", cursorSecret).update(value).digest();
  }

  function roomBinding(competitionId: string): string {
    return hmac(`room:${competitionId}`).toString("base64url");
  }

  function makeCursor(competitionId: string, afterSequence: number): string {
    // The payload binds only an exclusive sequence and an HMAC-derived room
    // tag. It contains no plaintext competition id and needs no registry.
    const payload = Buffer.from(JSON.stringify({ a: afterSequence, r: roomBinding(competitionId) })).toString("base64url");
    const signature = hmac(`cursor.v1:${payload}`).toString("base64url");
    return `chat.v1.${payload}.${signature}`;
  }

  function parseCursor(cursor: string, competitionId: string): number | null {
    const match = /^chat\.v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(cursor);
    if (!match) return null;

    const expectedSignature = hmac(`cursor.v1:${match[1]}`).toString("base64url");
    const suppliedSignature = match[2];
    if (suppliedSignature.length !== expectedSignature.length) return null;
    if (!timingSafeEqual(Buffer.from(suppliedSignature), Buffer.from(expectedSignature))) return null;

    try {
      const payload: unknown = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload) ||
        !Number.isSafeInteger((payload as { a?: unknown }).a) ||
        (payload as { a: number }).a < 0 ||
        typeof (payload as { r?: unknown }).r !== "string" ||
        (payload as { r: string }).r !== roomBinding(competitionId)
      ) {
        return null;
      }
      return (payload as { a: number }).a;
    } catch {
      return null;
    }
  }

  async function serialize<T>(competitionId: string, work: () => T | Promise<T>): Promise<T> {
    const previous = tails.get(competitionId) ?? Promise.resolve();
    let resolveTail: () => void;
    const tail = new Promise<void>((resolve) => {
      resolveTail = resolve;
    });
    tails.set(competitionId, previous.then(() => tail));
    await previous;
    try {
      return await work();
    } finally {
      resolveTail!();
    }
  }

  return {
    grantMembership(member) {
      const roomMembers = members.get(member.competition_id) ?? new Map<number, ChatActor>();
      roomMembers.set(member.github_id, { github_id: member.github_id, github_login: member.github_login });
      members.set(member.competition_id, roomMembers);
    },

    revokeMembership({ competition_id, github_id }) {
      members.get(competition_id)?.delete(github_id);
    },

    async post({ actor, competition_id, body, operation_id, reply_to_id }) {
      if (actor === null) return failure("unauthenticated");
      if (!isMember(competition_id, actor)) return failure("forbidden");
      if (typeof body !== "string" || body.length < 1 || body.length > MAX_BODY_LENGTH) return failure("invalid_body");

      return serialize(competition_id, () => {
        // Re-check after waiting: revocation wins over a queued post.
        if (!isMember(competition_id, actor)) return failure("forbidden");

        const key = operationKey(competition_id, actor.github_id, operation_id);
        const canonical = canonicalOperation(body, reply_to_id);
        const prior = operations.get(key);
        if (prior) return prior.canonical === canonical ? { ok: true, message: cloneMessage(prior.message) } : failure("conflict");

        const roomMessages = messages.get(competition_id) ?? [];
        if (reply_to_id !== undefined && !roomMessages.some((message) => message.id === reply_to_id)) return failure("not_found");

        const message: ChatMessage = {
          id: `chatmsg-${++messageSerial}`,
          competition_id,
          sequence: roomMessages.length + 1,
          body,
          author: { github_id: actor.github_id, github_login: actor.github_login },
          ...(reply_to_id === undefined ? {} : { reply_to_id }),
          mentions: mentionsIn(body),
        };
        roomMessages.push(message);
        messages.set(competition_id, roomMessages);
        operations.set(key, { canonical, message });
        return { ok: true, message: cloneMessage(message) };
      });
    },

    async list({ actor, competition_id, cursor, limit = DEFAULT_PAGE_LIMIT }) {
      if (actor === null) return failure("unauthenticated");
      if (!isMember(competition_id, actor)) return failure("forbidden");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) return failure("invalid_pagination");

      const roomMessages = messages.get(competition_id) ?? [];
      let afterSequence = 0;
      if (cursor !== undefined && cursor !== null) {
        const parsedAfterSequence = parseCursor(cursor, competition_id);
        if (parsedAfterSequence === null) return failure("invalid_cursor");
        afterSequence = parsedAfterSequence;
      }

      const highWaterMark = roomMessages.length;
      const available = roomMessages.filter((message) => message.sequence > afterSequence);
      const pageMessages = available.slice(0, limit).map(cloneMessage);
      const hasMore = available.length > pageMessages.length;
      const nextCursor =
        pageMessages.length === 0
          ? cursor ?? null
          : makeCursor(competition_id, pageMessages[pageMessages.length - 1].sequence);
      return {
        ok: true,
        page: { messages: pageMessages, next_cursor: nextCursor, has_more: hasMore, high_water_mark: highWaterMark },
      };
    },
  };
}
