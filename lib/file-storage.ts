import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Competition, NewRunEvent, Run, RunEvent, Submission } from "./types";
import type { Storage } from "./storage";

export class LocalStorageReadError extends Error {
  constructor(path: string, cause: unknown) {
    super(`local storage read failed for ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "LocalStorageReadError";
  }
}

const locks = new Map<string, Promise<void>>();

function safePart(value: string): string {
  if (!value || basename(value) !== value || value.includes("\\")) throw new Error("local storage key must be a single path segment");
  return value;
}

async function atomicWrite(path: string, value: string | Buffer): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

export class FileStorage implements Storage {
  readonly root: string;

  constructor(root: string) {
    if (!root) throw new Error("LOCAL_STORAGE_DIR is required when STORAGE=file");
    this.root = resolve(root);
  }

  private path(...parts: string[]): string {
    return join(this.root, ...parts.map(safePart));
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new LocalStorageReadError(path, cause);
    }
  }

  private async putJson(path: string, value: unknown): Promise<void> {
    await atomicWrite(path, JSON.stringify(value));
  }

  private async listJson<T>(directory: string): Promise<T[]> {
    try {
      const { readdir } = await import("node:fs/promises");
      const names = await readdir(directory);
      return Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => this.readJson<T>(join(directory, name)).then((value) => {
        if (value === undefined) throw new LocalStorageReadError(join(directory, name), new Error("document disappeared during read"));
        return value;
      })));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (cause instanceof LocalStorageReadError) throw cause;
      throw new LocalStorageReadError(directory, cause);
    }
  }

  async getSubmission(id: string) { return this.readJson<Submission>(this.path("submissions", `${safePart(id)}.json`)); }
  async putSubmission(value: Submission) { await this.putJson(this.path("submissions", `${safePart(value.id)}.json`), value); }
  async listSubmissions() { return (await this.listJson<Submission>(this.path("submissions"))).sort((a, b) => b.created_at.localeCompare(a.created_at)); }
  async getCompetition(id: string) { return this.readJson<Competition>(this.path("competitions", `${safePart(id)}.json`)); }
  async putCompetition(value: Competition) { await this.putJson(this.path("competitions", `${safePart(value.id)}.json`), value); }
  async listCompetitions() { return (await this.listJson<Competition>(this.path("competitions"))).sort((a, b) => b.created_at.localeCompare(a.created_at)); }
  async getRun(id: string) { return this.readJson<Run>(this.path("runs", `${safePart(id)}.json`)); }
  async putRun(value: Run) { await this.putJson(this.path("runs", `${safePart(value.id)}.json`), value); }
  async listRuns() { return (await this.listJson<Run>(this.path("runs"))).sort((a, b) => b.created_at.localeCompare(a.created_at)); }

  async appendRunEvents(runId: string, values: NewRunEvent[]): Promise<RunEvent[]> {
    const id = safePart(runId);
    return serial(`${this.root}:events:${id}`, async () => {
      const events = (await this.readJson<RunEvent[]>(this.path("events", `${id}.json`))) ?? [];
      let seq = events.reduce((max, event) => Math.max(max, event.seq), 0);
      const appended = values.map((event) => ({ ...event, run_id: id, seq: ++seq }));
      await this.putJson(this.path("events", `${id}.json`), [...events, ...appended]);
      return appended;
    });
  }

  async listRunEvents(runId: string) { return this.listRunEventsSince(runId, 0); }
  async listRunEventsSince(runId: string, sinceSeq: number) {
    const events = (await this.readJson<RunEvent[]>(this.path("events", `${safePart(runId)}.json`))) ?? [];
    return events.filter((event) => event.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
  }
  async latestEventTimestamp(runId: string) {
    const events = await this.listRunEvents(runId);
    return events.reduce<string | undefined>((latest, event) => !latest || event.ts > latest ? event.ts : latest, undefined);
  }
  async putTraceBlob(runId: string, taskId: string, name: string, data: Buffer | string) {
    const path = this.path("traces", safePart(runId), safePart(taskId), safePart(name));
    await atomicWrite(path, data);
    return `file://${path}`;
  }
  async getTraceBytes(runId: string, taskId: string, name: string) {
    const path = this.path("traces", safePart(runId), safePart(taskId), safePart(name));
    try { return await readFile(path); } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new LocalStorageReadError(path, cause);
    }
  }
}
