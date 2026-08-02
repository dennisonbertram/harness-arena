const MAX_WAIT_SECONDS = 25;
const MAX_LIMIT = 100;
const POLL_GAP_MS = 25;

export type ChatPollInput = {
  competition_id: string;
  after_cursor?: string;
  limit: number;
  wait_seconds: number;
  signal?: AbortSignal;
};

export type ChatSubscriptionsOptions = {
  client: { readCompetitionChat(input: ChatPollInput): Promise<unknown> };
  notify: (uri: string) => Promise<void>;
  retryBaseMs?: number;
  retryMaxMs?: number;
  random?: () => number;
};

type Subscription = {
  controller: AbortController;
  task: Promise<void>;
};

/** Returns an exact, canonical subscription target and never accepts query state. */
export function canonicalChatResourceUri(uri: string): { uri: string; competitionId: string } | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "harness-arena:" || parsed.hostname !== "competitions" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    const match = /^\/([^/]+)\/chat$/.exec(parsed.pathname);
    if (!match) return undefined;
    const competitionId = decodeURIComponent(match[1]);
    if (!competitionId) return undefined;
    const canonical = `harness-arena://competitions/${encodeURIComponent(competitionId)}/chat`;
    return uri === canonical ? { uri: canonical, competitionId } : undefined;
  } catch {
    return undefined;
  }
}

export class ChatSubscriptions {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly random: () => number;

  constructor(private readonly options: ChatSubscriptionsOptions) {
    this.retryBaseMs = Math.max(1, options.retryBaseMs ?? 250);
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 10_000);
    this.random = options.random ?? Math.random;
  }

  get workerCount(): number { return this.subscriptions.size; }

  subscribe(uri: string): boolean {
    const target = canonicalChatResourceUri(uri);
    if (!target) return false;
    if (this.subscriptions.has(target.uri)) return true;
    const controller = new AbortController();
    const task = this.run(target, controller.signal).finally(() => {
      const current = this.subscriptions.get(target.uri);
      if (current?.controller === controller) this.subscriptions.delete(target.uri);
    });
    this.subscriptions.set(target.uri, { controller, task });
    return true;
  }

  unsubscribe(uri: string): boolean {
    const target = canonicalChatResourceUri(uri);
    if (!target) return false;
    const subscription = this.subscriptions.get(target.uri);
    if (!subscription) return true;
    subscription.controller.abort();
    this.subscriptions.delete(target.uri);
    return true;
  }

  async close(): Promise<void> {
    const active = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const subscription of active) subscription.controller.abort();
    await Promise.allSettled(active.map(({ task }) => task));
  }

  private async run(target: { uri: string; competitionId: string }, signal: AbortSignal): Promise<void> {
    let cursor: string | undefined;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const result = await abortable(this.options.client.readCompetitionChat({
          competition_id: target.competitionId,
          ...(cursor === undefined ? {} : { after_cursor: cursor }),
          limit: MAX_LIMIT,
          wait_seconds: MAX_WAIT_SECONDS,
          signal,
        }), signal);
        if (signal.aborted) break;
        const update = chatUpdate(result);
        const cursorChanged = update.cursor !== undefined && update.cursor !== cursor;
        if (update.cursor !== undefined) cursor = update.cursor;
        // A cursor is the durable new-message marker. Only fall back to a message count
        // for a malformed/legacy response that omitted its cursor.
        if ((cursorChanged || (update.messages > 0 && update.cursor === undefined)) && !signal.aborted) {
          try { await this.options.notify(target.uri); } catch { /* Transport loss is handled by close. */ }
        }
        failures = 0;
        await delay(POLL_GAP_MS, signal);
      } catch {
        if (signal.aborted) break;
        const cap = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(failures, 8));
        failures += 1;
        // Keep retries bounded and do not log API errors: they can contain untrusted or sensitive data.
        await delay(Math.floor(cap * (0.5 + this.random() * 0.5)), signal);
      }
    }
  }
}

function chatUpdate(value: unknown): { messages: number; cursor?: string } {
  if (!value || typeof value !== "object") return { messages: 0 };
  const page = "page" in value && value.page && typeof value.page === "object" ? value.page as Record<string, unknown> : value as Record<string, unknown>;
  return {
    messages: Array.isArray(page.messages) ? page.messages.length : 0,
    ...(typeof page.next_cursor === "string" && page.next_cursor.length > 0 ? { cursor: page.next_cursor } : {}),
  };
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.max(0, milliseconds));
    const onAbort = () => { clearTimeout(timer); done(); };
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("subscription aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("subscription aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
