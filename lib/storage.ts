import { get, list, put } from "@vercel/blob";
import { blobCommandOptions } from "./blob-access";
import { readBlobJson } from "./blob-read.mjs";
import { readBoundedStream } from "./bounded-stream";
import { FileStorage } from "./file-storage";
import { log, normalizeError } from "./log";
import type { Competition, NewRunEvent, Run, RunEvent, Submission } from "./types";
import { BLOB_PATHS } from "./blob-paths.mjs";

export interface Storage {
  getSubmission(id: string): Promise<Submission | undefined>;
  putSubmission(submission: Submission): Promise<void>;
  listSubmissions(): Promise<Submission[]>;
  getCompetition(id: string): Promise<Competition | undefined>;
  putCompetition(competition: Competition): Promise<void>;
  /** Same partial-read contract as listSubmissions/listRuns -- see PartialReadError. */
  listCompetitions(): Promise<Competition[]>;
  getRun(id: string): Promise<Run | undefined>;
  putRun(run: Run): Promise<void>;
  listRuns(): Promise<Run[]>;
  /** Assigns each event a monotonic seq (1..n, continuing across batches) and returns them with seq/run_id filled in. */
  appendRunEvents(runId: string, events: NewRunEvent[]): Promise<RunEvent[]>;
  /** Returns all events for a run in strict seq order. Best-effort: skips any event that can't be read. */
  listRunEvents(runId: string): Promise<RunEvent[]>;
  /**
   * Events with `seq > sinceSeq`, in strict seq order. Same best-effort
   * contract as listRunEvents. Exists so a poller that already holds events
   * up to N doesn't re-read the whole log every tick -- see BlobStorage's
   * implementation for why that matters.
   */
  listRunEventsSince(runId: string, sinceSeq: number): Promise<RunEvent[]>;
  /**
   * Cheap staleness probe for the reaper: the timestamp of the most recent
   * event, or undefined if none. Must NOT fetch every event's content (the
   * reaper runs on every run read); Blob derives it from list() metadata.
   */
  latestEventTimestamp(runId: string): Promise<string | undefined>;
  putTraceBlob(runId: string, taskId: string, name: string, data: Buffer | string): Promise<string>;
  /** Raw bytes of a stored trace blob, or null if it doesn't exist. */
  getTraceBytes(runId: string, taskId: string, name: string): Promise<Buffer | null>;
}

// In-memory implementation used by tests and by BlobStorage's internal
// event log emulation is NOT shared — this is a standalone impl for
// local/test use. Nothing here survives a process restart.
export class MemoryStorage implements Storage {
  private submissions = new Map<string, Submission>();
  private competitions = new Map<string, Competition>();
  private runs = new Map<string, Run>();
  private events = new Map<string, RunEvent[]>();
  private traces = new Map<string, Buffer>();

  async getSubmission(id: string): Promise<Submission | undefined> {
    return this.submissions.get(id);
  }

  async putSubmission(submission: Submission): Promise<void> {
    this.submissions.set(submission.id, submission);
  }

  async listSubmissions(): Promise<Submission[]> {
    return [...this.submissions.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getCompetition(id: string): Promise<Competition | undefined> {
    return this.competitions.get(id);
  }

  async putCompetition(competition: Competition): Promise<void> {
    this.competitions.set(competition.id, competition);
  }

  async listCompetitions(): Promise<Competition[]> {
    return [...this.competitions.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getRun(id: string): Promise<Run | undefined> {
    return this.runs.get(id);
  }

  async putRun(run: Run): Promise<void> {
    this.runs.set(run.id, run);
  }

  async listRuns(): Promise<Run[]> {
    return [...this.runs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async appendRunEvents(runId: string, newEvents: NewRunEvent[]): Promise<RunEvent[]> {
    const existing = this.events.get(runId) ?? [];
    let seq = existing.length;
    const appended: RunEvent[] = newEvents.map((event) => {
      seq += 1;
      return { ...event, run_id: runId, seq };
    });
    this.events.set(runId, [...existing, ...appended]);
    return appended;
  }

  async listRunEvents(runId: string): Promise<RunEvent[]> {
    return this.listRunEventsSince(runId, 0);
  }

  async listRunEventsSince(runId: string, sinceSeq: number): Promise<RunEvent[]> {
    return [...(this.events.get(runId) ?? [])].filter((e) => e.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
  }

  async latestEventTimestamp(runId: string): Promise<string | undefined> {
    const events = this.events.get(runId);
    if (!events || events.length === 0) return undefined;
    return events.reduce((latest, e) => (e.ts > latest ? e.ts : latest), events[0].ts);
  }

  async putTraceBlob(runId: string, taskId: string, name: string, data: Buffer | string): Promise<string> {
    const key = `${BLOB_PATHS.traces}${runId}/${taskId}/${name}`;
    const url = `memory://${key}`;
    this.traces.set(key, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
    return url;
  }

  async getTraceBytes(runId: string, taskId: string, name: string): Promise<Buffer | null> {
    return this.traces.get(`${BLOB_PATHS.traces}${runId}/${taskId}/${name}`) ?? null;
  }
}

// Blob-backed implementation. Per-entity JSON documents at
// submissions/<id>.json and runs/<id>.json. Events are stored one-per-blob
// at events/<runId>/<10-digit zero-padded seq>.json (e.g. seq 7 ->
// events/run-1/0000000007.json) instead of a single rewritten JSONL file:
// Vercel Blob reads are not immediately consistent after a write, so a
// read-modify-rewrite of one shared file loses concurrent-in-time appends
// (confirmed in production: run 489288d4 persisted ~12 of ~50 events).
// Each event blob is written once (allowOverwrite: false) and never
// rewritten, eliminating the read-modify-rewrite race entirely.
// Vercel Blob is eventually consistent and rate-limits reads: a blob can
// briefly 403/404 (returning an HTML error page, not JSON) right after it's
// written or under a burst of reads. A single failed read must never crash a
// route, so blob reads retry a few times and list reads skip individual
// failures rather than rejecting the whole batch.
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof Error && err.name === "PayloadTooLargeError") throw err;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  log("error", "storage.retry_exhausted", { attempts, ...normalizeError(lastErr, "storage_retry") });
  throw lastErr;
}

/**
 * Thrown when a list read could not return every stored item.
 *
 * Blob rate-limits reads, and a partial result is NOT a smaller valid answer
 * here: aggregatePrompts groups runs by their submission, so a submission
 * that failed to read turns its runs into `__unknown:<runId>` singletons and
 * the leaderboard silently publishes fabricated standings (observed live:
 * the same endpoint returned 17, then 16, then 10 standings within seconds,
 * every one labelled "unknown"). Callers that aggregate must fail loudly
 * rather than compute on a subset.
 */
export class PartialReadError extends Error {
  constructor(
    readonly prefix: string,
    readonly missing: number,
    readonly total: number,
  ) {
    super(`partial read of ${prefix}: ${missing} of ${total} blobs unreadable after retries`);
    this.name = "PartialReadError";
  }
}

/**
 * The seq encoded in an event blob's pathname
 * (`events/<runId>/0000000007.json` -> 7), or null when the name isn't that
 * shape. Null means "can't tell" and callers keep the blob rather than
 * dropping it, so a stray/renamed file is never silently lost.
 */
export function seqFromEventPathname(pathname: string | undefined): number | null {
  const match = /(?:^|\/)(\d+)\.json$/.exec(pathname ?? "");
  if (!match) return null;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) ? seq : null;
}

async function getJson<T>(identifier: string): Promise<T> {
  return await readBlobJson<T>(identifier, { required: true }) as T;
}

export class BlobStorage implements Storage {
  private static readonly TRACE_LIMIT = 4 * 1024 * 1024;
  private readonly readConcurrency = 8;
  private activeReads = 0;
  private readonly readWaiters: Array<() => void> = [];

  private async withReadSlot<T>(read: () => Promise<T>): Promise<T> {
    if (this.activeReads >= this.readConcurrency) {
      await new Promise<void>((resolve) => this.readWaiters.push(resolve));
    }
    this.activeReads += 1;
    try {
      return await read();
    } finally {
      this.activeReads -= 1;
      this.readWaiters.shift()?.();
    }
  }

  private async readListedJson<T>(blob: {
    url: string;
    pathname: string;
    uploadedAt: string | Date;
  }): Promise<T> {
    // listRuns/listSubmissions/listCompetitions are often requested together.
    // Keep one instance-wide semaphore across all three so Promise.all cannot
    // turn a 90-object page read into 90 simultaneous Blob requests.
    return this.withReadSlot(() => withRetry(() => getJson<T>(blob.pathname), 2));
  }

  private async readJson<T>(pathname: string): Promise<T | undefined> {
    // Resolve the exact current blob before reading. The authenticated fallback
    // in readListedJson covers the production failure where Vercel Functions
    // received persistent 403s from the otherwise-public Blob URL.
    const blobs = await withRetry(() => this.listAllBlobs(pathname));
    const blob = blobs.find((candidate) => candidate.pathname === pathname);
    if (!blob) return undefined;
    return this.readListedJson<T>(blob);
  }

  private async writeJson(pathname: string, value: unknown): Promise<void> {
    // Retry: Blob rate-limits writes under a high-volume run (a 16-task run
    // emits ~90 event blobs + ~32 trace blobs), and an un-retried put failure
    // there 500'd the callback route and lost the run's totals.
    await withRetry(() =>
      put(pathname, JSON.stringify(value), blobCommandOptions({
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
        contentType: "application/json",
      })),
    );
  }

  async getSubmission(id: string): Promise<Submission | undefined> {
    return this.readJson<Submission>(`${BLOB_PATHS.submissions}${id}.json`);
  }

  async putSubmission(submission: Submission): Promise<void> {
    await this.writeJson(`${BLOB_PATHS.submissions}${submission.id}.json`, submission);
  }

  private async listAllBlobs(prefix: string): Promise<{ url: string; pathname: string; uploadedAt: string | Date }[]> {
    const blobs: { url: string; pathname: string; uploadedAt: string | Date }[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(blobCommandOptions({ prefix, cursor }));
      blobs.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return blobs;
  }
  async listSubmissions(): Promise<Submission[]> {
    const blobs = await this.listAllBlobs(BLOB_PATHS.submissions);
    const results = await Promise.all(
      blobs.map((blob) =>
        this.readListedJson<Submission>(blob).catch(() => undefined),
      ),
    );
    const found = results.filter((s): s is Submission => s !== undefined);
    // Fail loud on an incomplete read -- see PartialReadError. Each entry
    // already retried 3x, so reaching here means a genuine failure, not a
    // single blip.
    if (found.length !== results.length) {
      throw new PartialReadError("submissions/", results.length - found.length, results.length);
    }
    return found.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getCompetition(id: string): Promise<Competition | undefined> {
    return this.readJson<Competition>(`${BLOB_PATHS.competitions}${id}.json`);
  }

  async putCompetition(competition: Competition): Promise<void> {
    await this.writeJson(`${BLOB_PATHS.competitions}${competition.id}.json`, competition);
  }

  async listCompetitions(): Promise<Competition[]> {
    const blobs = await this.listAllBlobs(BLOB_PATHS.competitions);
    const results = await Promise.all(
      blobs.map((blob) =>
        this.readListedJson<Competition>(blob).catch(() => undefined),
      ),
    );
    const found = results.filter((c): c is Competition => c !== undefined);
    // Fail loud on an incomplete read -- same contract as listSubmissions:
    // a dropped competition must not silently vanish from a switcher/listing.
    if (found.length !== results.length) {
      throw new PartialReadError("competitions/", results.length - found.length, results.length);
    }
    return found.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getRun(id: string): Promise<Run | undefined> {
    return this.readJson<Run>(`${BLOB_PATHS.runs}${id}.json`);
  }

  async putRun(run: Run): Promise<void> {
    await this.writeJson(`${BLOB_PATHS.runs}${run.id}.json`, run);
  }

  async listRuns(): Promise<Run[]> {
    const blobs = await this.listAllBlobs(BLOB_PATHS.runs);
    const results = await Promise.all(
      blobs.map((blob) => this.readListedJson<Run>(blob).catch(() => undefined)),
    );
    const found = results.filter((r): r is Run => r !== undefined);
    // Fail loud on an incomplete read -- a missing run silently changes every
    // aggregate computed from this list (pass rate, run counts, cost).
    if (found.length !== results.length) {
      throw new PartialReadError("runs/", results.length - found.length, results.length);
    }
    return found.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async appendRunEvents(runId: string, newEvents: NewRunEvent[]): Promise<RunEvent[]> {
    // ponytail: two concurrent appendRunEvents calls for the SAME run could
    // both list the same existing count and compute the same starting seq
    // (a write-write race, not the read-modify-rewrite bug this fixes). The
    // runner only ever calls appendRunEvents sequentially per run, so this
    // doesn't happen in practice — add per-run locking / a CAS if a second
    // concurrent writer per run is ever introduced.
    const existing = await this.listAllBlobs(`${BLOB_PATHS.events}${runId}/`);
    let seq = existing.length;
    const appended: RunEvent[] = [];
    for (const event of newEvents) {
      seq += 1;
      // list() lag can make two sequential appends compute the same starting
      // seq; allowOverwrite:false then throws "already exists" on the second.
      // Retry with the next seq (bounded) rather than clobbering or failing
      // the callback (which would drop the whole event batch).
      for (let tries = 0; tries < 50; tries++) {
        try {
          const full: RunEvent = { ...event, run_id: runId, seq };
          await put(`${BLOB_PATHS.events}${runId}/${String(seq).padStart(10, "0")}.json`, JSON.stringify(full), blobCommandOptions({
            addRandomSuffix: false,
            allowOverwrite: false,
            contentType: "application/json",
          }));
          appended.push(full);
          break;
        } catch {
          seq += 1; // path collided (or transient) — advance and retry
        }
      }
    }
    return appended;
  }

  async listRunEvents(runId: string): Promise<RunEvent[]> {
    return this.listRunEventsSince(runId, 0);
  }

  async listRunEventsSince(runId: string, sinceSeq: number): Promise<RunEvent[]> {
    const blobs = await this.listAllBlobs(`${BLOB_PATHS.events}${runId}/`);
    // The seq is encoded in the blob NAME (zero-padded, see appendRunEvents),
    // so filtering happens on list() metadata -- before any content fetch.
    // That's the whole point: a 16-task run emits ~90 event blobs, and a
    // poller re-reading all of them every tick is O(events) per poll and
    // grows as the run progresses. With a cursor it fetches only what's new.
    // A name that doesn't parse is kept (fail-open), so an unexpected blob is
    // never silently dropped from the full listing.
    const fresh = blobs.filter((b) => {
      const seq = seqFromEventPathname(b.pathname);
      return seq === null || seq > sinceSeq;
    });
    const results = await Promise.all(
      fresh.map(async (blob) => {
        try {
          return { event: await this.readListedJson<RunEvent>(blob), unreadableSeq: null };
        } catch {
          // Don't 500 the route -- but remember WHICH seq we couldn't read.
          return { event: undefined, unreadableSeq: seqFromEventPathname(blob.pathname) };
        }
      }),
    );

    // Never return an event from beyond a transient hole. Callers resume from
    // the last seq they received, so handing back N+1 while N was merely
    // unreadable-right-now (Blob is eventually consistent and rate-limits
    // reads) would skip N FOREVER, even once it becomes readable.
    //
    // Only a blob that EXISTS but failed to read blocks. A seq with no blob at
    // all is a permanent gap -- appendRunEvents advances seq on a write
    // collision, so those are legitimate -- and must not block, or the cursor
    // would stall on it for good. An unreadable blob whose name doesn't parse
    // gives us no seq to truncate at, so it can't block either.
    const firstUnreadable = results.reduce<number | null>(
      (min, r) => (r.unreadableSeq === null ? min : min === null || r.unreadableSeq < min ? r.unreadableSeq : min),
      null,
    );

    return results
      .map((r) => r.event)
      .filter((e): e is RunEvent => e !== undefined)
      .filter((e) => e.seq > sinceSeq && (firstUnreadable === null || e.seq < firstUnreadable))
      .sort((a, b) => a.seq - b.seq);
  }

  async latestEventTimestamp(runId: string): Promise<string | undefined> {
    // Cheap: list() metadata only (no per-event content fetch). Event blob
    // names are zero-padded seq, so the lexically-last name is the newest
    // event; its blob uploadedAt is a fine staleness proxy for the reaper.
    const blobs = await this.listAllBlobs(`${BLOB_PATHS.events}${runId}/`);
    if (blobs.length === 0) return undefined;
    return blobs.reduce<string>((latest, b) => {
      const ts = new Date(b.uploadedAt).toISOString();
      return ts > latest ? ts : latest;
    }, new Date(0).toISOString());
  }

  async putTraceBlob(runId: string, taskId: string, name: string, data: Buffer | string): Promise<string> {
    const { url } = await withRetry(() =>
      put(`${BLOB_PATHS.traces}${runId}/${taskId}/${name}`, data, blobCommandOptions({
        addRandomSuffix: false,
        allowOverwrite: true,
      })),
    );
    return url;
  }

  async getTraceBytes(runId: string, taskId: string, name: string): Promise<Buffer | null> {
    try {
      return await withRetry(async () => {
        const pathname = `${BLOB_PATHS.traces}${runId}/${taskId}/${name}`;
        const blobs = await this.listAllBlobs(pathname);
        const blob = blobs.find((candidate) => candidate.pathname === pathname);
        if (!blob) return null;
        const response = await get(blob.pathname, blobCommandOptions());
        if (!response || response.statusCode !== 200 || !response.stream) throw new Error("blob get failed");
        return readBoundedStream(response.stream, BlobStorage.TRACE_LIMIT);
      });
    } catch {
      return null;
    }
  }
}

// Pinned on globalThis, not a module-level `let`. Next.js gives server
// components and route handlers separate module graphs, so a module-scoped
// singleton is per-graph: a competition created through a route handler is
// invisible to the page that renders it. This is what makes STORAGE=memory
// usable for a real request flow instead of only within one graph.
const MEMORY_STORAGE_KEY = Symbol.for("harness-arena.memory-storage");
type MemoryStorageGlobal = typeof globalThis & { [MEMORY_STORAGE_KEY]?: MemoryStorage };

export function getStorage(): Storage {
  if (process.env.STORAGE === "file") return new FileStorage(process.env.LOCAL_STORAGE_DIR ?? "");
  if (process.env.STORAGE === "memory") {
    const g = globalThis as MemoryStorageGlobal;
    g[MEMORY_STORAGE_KEY] ??= new MemoryStorage();
    return g[MEMORY_STORAGE_KEY];
  }
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_OIDC_TOKEN) { blobCommandOptions(); return new BlobStorage(); }
  throw new Error("storage misconfigured: set BLOB_READ_WRITE_TOKEN or STORAGE=memory");
}
