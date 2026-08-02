import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { appendRunEventsFile, atomicWriteFile, safeStoragePart } from "./file-storage-lock.mjs";
import type { Competition, NewRunEvent, Run, RunEvent, Submission } from "./types";
import type { Storage } from "./storage";

export class LocalStorageReadError extends Error {
  constructor(path: string, cause: unknown) {
    super(`local storage read failed for ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "LocalStorageReadError";
  }
}

export { safeStoragePart } from "./file-storage-lock.mjs";

export function assertLocalFileStorageAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production") throw new Error("local file storage is disabled in production");
  if (env.VERCEL || env.VERCEL_ENV || env.VERCEL_URL || env.VERCEL_REGION) {
    throw new Error("local file storage is disabled on Vercel");
  }
}

export class FileStorage implements Storage {
  readonly root: string;

  constructor(root: string) {
    assertLocalFileStorageAllowed();
    if (!root) throw new Error("LOCAL_STORAGE_DIR is required when STORAGE=file");
    this.root = resolve(root);
  }

  private path(...parts: string[]): string {
    return join(this.root, ...parts.map(safeStoragePart));
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
    await atomicWriteFile(path, JSON.stringify(value));
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

  async getSubmission(id: string) { return this.readJson<Submission>(this.path("submissions", `${safeStoragePart(id)}.json`)); }
  async putSubmission(value: Submission) { await this.putJson(this.path("submissions", `${safeStoragePart(value.id)}.json`), value); }
  async listSubmissions() { return (await this.listJson<Submission>(this.path("submissions"))).sort((a, b) => b.created_at.localeCompare(a.created_at)); }
  async getCompetition(id: string) { return this.readJson<Competition>(this.path("competitions", `${safeStoragePart(id)}.json`)); }
  async putCompetition(value: Competition) { await this.putJson(this.path("competitions", `${safeStoragePart(value.id)}.json`), value); }
  async listCompetitions() { return (await this.listJson<Competition>(this.path("competitions"))).sort((a, b) => b.created_at.localeCompare(a.created_at)); }
  async getRun(id: string) { return this.readJson<Run>(this.path("runs", `${safeStoragePart(id)}.json`)); }
  async putRun(value: Run) { await this.putJson(this.path("runs", `${safeStoragePart(value.id)}.json`), value); }
  async listRuns() { return (await this.listJson<Run>(this.path("runs"))).sort((a, b) => b.created_at.localeCompare(a.created_at)); }

  async appendRunEvents(runId: string, values: NewRunEvent[]): Promise<RunEvent[]> {
    return appendRunEventsFile(this.root, safeStoragePart(runId), values);
  }

  async listRunEvents(runId: string) { return this.listRunEventsSince(runId, 0); }
  async listRunEventsSince(runId: string, sinceSeq: number) {
    const events = (await this.readJson<RunEvent[]>(this.path("events", `${safeStoragePart(runId)}.json`))) ?? [];
    return events.filter((event) => event.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
  }
  async latestEventTimestamp(runId: string) {
    const events = await this.listRunEvents(runId);
    return events.reduce<string | undefined>((latest, event) => !latest || event.ts > latest ? event.ts : latest, undefined);
  }
  async putTraceBlob(runId: string, taskId: string, name: string, data: Buffer | string) {
    const path = this.path("traces", safeStoragePart(runId), safeStoragePart(taskId), safeStoragePart(name));
    await atomicWriteFile(path, data);
    return `file://${path}`;
  }
  async getTraceBytes(runId: string, taskId: string, name: string) {
    const path = this.path("traces", safeStoragePart(runId), safeStoragePart(taskId), safeStoragePart(name));
    try { return await readFile(path); } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new LocalStorageReadError(path, cause);
    }
  }

  async checkReady(): Promise<{ seeded: true; writable: true }> {
    const seeded = await this.getCompetition("local-development");
    if (!seeded || seeded.auto_baseline !== false) throw new Error("local storage seed is missing or unsafe");
    const probe = this.path("ready", `probe-${process.pid}-${crypto.randomUUID()}.txt`);
    try {
      await atomicWriteFile(probe, "ready");
      if (await readFile(probe, "utf8") !== "ready") throw new Error("local storage write probe mismatch");
    } finally {
      await rm(probe, { force: true });
    }
    return { seeded: true, writable: true };
  }
}
