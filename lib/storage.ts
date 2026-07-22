import { get, list, put } from "@vercel/blob";
import type { NewRunEvent, Run, RunEvent, Submission } from "./types";

export interface Storage {
  getSubmission(id: string): Promise<Submission | undefined>;
  putSubmission(submission: Submission): Promise<void>;
  listSubmissions(): Promise<Submission[]>;
  getRun(id: string): Promise<Run | undefined>;
  putRun(run: Run): Promise<void>;
  listRuns(): Promise<Run[]>;
  /** Assigns each event a monotonic seq (1..n, continuing across batches) and returns them with seq/run_id filled in. */
  appendRunEvents(runId: string, events: NewRunEvent[]): Promise<RunEvent[]>;
  /** Returns all events for a run in strict seq order. Best-effort: skips any event that can't be read. */
  listRunEvents(runId: string): Promise<RunEvent[]>;
  /**
   * Cheap staleness probe for the reaper: the timestamp of the most recent
   * event, or undefined if none. Must NOT fetch every event's content (the
   * reaper runs on every run read); Blob derives it from list() metadata.
   */
  latestEventTimestamp(runId: string): Promise<string | undefined>;
  putTraceBlob(runId: string, taskId: string, name: string, data: Buffer | string): Promise<string>;
}

// In-memory implementation used by tests and by BlobStorage's internal
// event log emulation is NOT shared — this is a standalone impl for
// local/test use. Nothing here survives a process restart.
export class MemoryStorage implements Storage {
  private submissions = new Map<string, Submission>();
  private runs = new Map<string, Run>();
  private events = new Map<string, RunEvent[]>();
  private traces = new Map<string, string>();

  async getSubmission(id: string): Promise<Submission | undefined> {
    return this.submissions.get(id);
  }

  async putSubmission(submission: Submission): Promise<void> {
    this.submissions.set(submission.id, submission);
  }

  async listSubmissions(): Promise<Submission[]> {
    return [...this.submissions.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
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
    return [...(this.events.get(runId) ?? [])].sort((a, b) => a.seq - b.seq);
  }

  async latestEventTimestamp(runId: string): Promise<string | undefined> {
    const events = this.events.get(runId);
    if (!events || events.length === 0) return undefined;
    return events.reduce((latest, e) => (e.ts > latest ? e.ts : latest), events[0].ts);
  }

  async putTraceBlob(runId: string, taskId: string, name: string, data: Buffer | string): Promise<string> {
    const key = `traces/${runId}/${taskId}/${name}`;
    const url = `memory://${key}`;
    this.traces.set(key, typeof data === "string" ? data : data.toString("utf8"));
    return url;
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
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw lastErr;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  // Blob 403/404s return an HTML error page, not JSON, so a non-OK response
  // must throw BEFORE parsing (a bare JSON.parse on "<!DOCTYPE..." is the
  // exact crash this replaces). res.ok may be undefined in unit mocks; only
  // a strictly-false ok is treated as a failure.
  if (res.ok === false) throw new Error(`blob fetch ${res.status}`);
  return JSON.parse(await res.text()) as T;
}

export class BlobStorage implements Storage {
  private async readJson<T>(pathname: string): Promise<T | undefined> {
    return withRetry(async () => {
      const result = await get(pathname, { access: "public" });
      if (!result) return undefined;
      const text = await new Response(result.stream).text();
      return JSON.parse(text) as T;
    });
  }

  private async writeJson(pathname: string, value: unknown): Promise<void> {
    await put(pathname, JSON.stringify(value), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
  }

  async getSubmission(id: string): Promise<Submission | undefined> {
    return this.readJson<Submission>(`submissions/${id}.json`);
  }

  async putSubmission(submission: Submission): Promise<void> {
    await this.writeJson(`submissions/${submission.id}.json`, submission);
  }

  private async listAllBlobs(prefix: string): Promise<{ url: string; uploadedAt: string | Date }[]> {
    const blobs: { url: string; uploadedAt: string | Date }[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor });
      blobs.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return blobs;
  }

  async listSubmissions(): Promise<Submission[]> {
    const blobs = await this.listAllBlobs("submissions/");
    const results = await Promise.all(
      blobs.map((blob) => withRetry(() => fetchJson<Submission>(blob.url), 3).catch(() => undefined)),
    );
    return results
      .filter((s): s is Submission => s !== undefined)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getRun(id: string): Promise<Run | undefined> {
    return this.readJson<Run>(`runs/${id}.json`);
  }

  async putRun(run: Run): Promise<void> {
    await this.writeJson(`runs/${run.id}.json`, run);
  }

  async listRuns(): Promise<Run[]> {
    const blobs = await this.listAllBlobs("runs/");
    const results = await Promise.all(
      blobs.map((blob) => withRetry(() => fetchJson<Run>(blob.url), 3).catch(() => undefined)),
    );
    return results
      .filter((r): r is Run => r !== undefined)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async appendRunEvents(runId: string, newEvents: NewRunEvent[]): Promise<RunEvent[]> {
    // ponytail: two concurrent appendRunEvents calls for the SAME run could
    // both list the same existing count and compute the same starting seq
    // (a write-write race, not the read-modify-rewrite bug this fixes). The
    // runner only ever calls appendRunEvents sequentially per run, so this
    // doesn't happen in practice — add per-run locking / a CAS if a second
    // concurrent writer per run is ever introduced.
    const existing = await this.listAllBlobs(`events/${runId}/`);
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
          await put(`events/${runId}/${String(seq).padStart(10, "0")}.json`, JSON.stringify(full), {
            access: "public",
            addRandomSuffix: false,
            allowOverwrite: false,
            contentType: "application/json",
          });
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
    const blobs = await this.listAllBlobs(`events/${runId}/`);
    const results = await Promise.all(
      blobs.map(async (blob) => {
        try {
          return await withRetry(() => fetchJson<RunEvent>(blob.url), 3);
        } catch {
          return undefined; // skip an event we can't read rather than 500 the route
        }
      }),
    );
    return results.filter((e): e is RunEvent => e !== undefined).sort((a, b) => a.seq - b.seq);
  }

  async latestEventTimestamp(runId: string): Promise<string | undefined> {
    // Cheap: list() metadata only (no per-event content fetch). Event blob
    // names are zero-padded seq, so the lexically-last name is the newest
    // event; its blob uploadedAt is a fine staleness proxy for the reaper.
    const blobs = await this.listAllBlobs(`events/${runId}/`);
    if (blobs.length === 0) return undefined;
    return blobs.reduce<string>((latest, b) => {
      const ts = new Date(b.uploadedAt).toISOString();
      return ts > latest ? ts : latest;
    }, new Date(0).toISOString());
  }

  async putTraceBlob(runId: string, taskId: string, name: string, data: Buffer | string): Promise<string> {
    const { url } = await put(`traces/${runId}/${taskId}/${name}`, data, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return url;
  }
}

export function getStorage(): Storage {
  if (process.env.STORAGE === "memory") return new MemoryStorage();
  if (process.env.BLOB_READ_WRITE_TOKEN) return new BlobStorage();
  throw new Error("storage misconfigured: set BLOB_READ_WRITE_TOKEN or STORAGE=memory");
}
