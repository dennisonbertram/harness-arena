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
  /** Returns all events for a run in strict seq order. */
  listRunEvents(runId: string): Promise<RunEvent[]>;
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

  async putTraceBlob(runId: string, taskId: string, name: string, data: Buffer | string): Promise<string> {
    const key = `traces/${runId}/${taskId}/${name}`;
    const url = `memory://${key}`;
    this.traces.set(key, typeof data === "string" ? data : data.toString("utf8"));
    return url;
  }
}

// Blob-backed implementation. Per-entity JSON documents at
// submissions/<id>.json and runs/<id>.json; events are a single JSONL blob
// per run at events/<runId>.jsonl, rewritten wholesale on each append
// (acceptable at POC scale per ticket #4 — single writer per run assumed,
// no concurrent-append locking).
// ponytail: read-modify-rewrite the whole events file on every append —
// O(n) per append, fine until run event counts get large; move to a real
// append-only store (or Postgres) if that ever matters.
export class BlobStorage implements Storage {
  private async readJson<T>(pathname: string): Promise<T | undefined> {
    const result = await get(pathname, { access: "public" });
    if (!result) return undefined;
    const text = await new Response(result.stream).text();
    return JSON.parse(text) as T;
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

  private async listAllBlobs(prefix: string): Promise<{ url: string }[]> {
    const blobs: { url: string }[] = [];
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
    const submissions = await Promise.all(
      blobs.map(async (blob) => {
        const text = await (await fetch(blob.url)).text();
        return JSON.parse(text) as Submission;
      }),
    );
    return submissions.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getRun(id: string): Promise<Run | undefined> {
    return this.readJson<Run>(`runs/${id}.json`);
  }

  async putRun(run: Run): Promise<void> {
    await this.writeJson(`runs/${run.id}.json`, run);
  }

  async listRuns(): Promise<Run[]> {
    const blobs = await this.listAllBlobs("runs/");
    const runs = await Promise.all(
      blobs.map(async (blob) => {
        const text = await (await fetch(blob.url)).text();
        return JSON.parse(text) as Run;
      }),
    );
    return runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  private async readEvents(runId: string): Promise<RunEvent[]> {
    const result = await get(`events/${runId}.jsonl`, { access: "public" });
    if (!result) return [];
    const raw = await new Response(result.stream).text();
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RunEvent);
  }

  async appendRunEvents(runId: string, newEvents: NewRunEvent[]): Promise<RunEvent[]> {
    const existing = await this.readEvents(runId);
    let seq = existing.length;
    const appended: RunEvent[] = newEvents.map((event) => {
      seq += 1;
      return { ...event, run_id: runId, seq };
    });
    const allLines = [...existing, ...appended].map((event) => JSON.stringify(event)).join("\n");
    await put(`events/${runId}.jsonl`, allLines, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/jsonl",
    });
    return appended;
  }

  async listRunEvents(runId: string): Promise<RunEvent[]> {
    const events = await this.readEvents(runId);
    return events.sort((a, b) => a.seq - b.seq);
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
