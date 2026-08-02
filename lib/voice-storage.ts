import { list, put } from "@vercel/blob";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fetchJson, withRetry } from "./storage";
import { VoiceJudgmentSchema, VoiceManifestSchema } from "./voice-types";
import type { VoiceJudgment, VoiceManifest } from "./voice-types";

const MANIFEST_PATH = "voice/manifest.json";
const JUDGMENTS_PREFIX = "voice/judgments/";
const LIST_CONCURRENCY = 20;

function judgmentPrefix(evaluatorId: string): string {
  return `${JUDGMENTS_PREFIX}${evaluatorId}/`;
}

function judgmentPath(evaluatorId: string, comparisonId: string): string {
  return `${judgmentPrefix(evaluatorId)}${comparisonId}.json`;
}

// @vercel/blob 2.6.1 has no typed conflict error for allowOverwrite:false —
// this is the only way to distinguish "already judged" from a real failure.
function isAlreadyExistsError(err: unknown): boolean {
  return err instanceof Error && /already exists/i.test(err.message);
}

export interface VoiceStorage {
  getManifest(): Promise<VoiceManifest | undefined>;
  putManifest(manifest: VoiceManifest): Promise<void>;
  /** Write-once: a duplicate comparison_id/evaluator_id key returns { created: false } instead of throwing. */
  putJudgment(judgment: VoiceJudgment): Promise<{ created: boolean }>;
  /** Comparison IDs already judged by this evaluator, derived from blob key metadata only — no content fetches. */
  listJudgmentKeys(evaluatorId: string): Promise<string[]>;
  /** Best-effort: judgments that can't be fetched or fail schema validation are skipped and counted, not thrown. */
  listAllJudgments(): Promise<{ judgments: VoiceJudgment[]; unreadable: number }>;
}

export class MemoryVoiceStorage implements VoiceStorage {
  private manifest: VoiceManifest | undefined;
  private judgments = new Map<string, VoiceJudgment>();

  async getManifest(): Promise<VoiceManifest | undefined> {
    return this.manifest;
  }

  async putManifest(manifest: VoiceManifest): Promise<void> {
    this.manifest = manifest;
  }

  async putJudgment(judgment: VoiceJudgment): Promise<{ created: boolean }> {
    const key = judgmentPath(judgment.evaluator_id, judgment.comparison_id);
    if (this.judgments.has(key)) return { created: false };
    this.judgments.set(key, judgment);
    return { created: true };
  }

  async listJudgmentKeys(evaluatorId: string): Promise<string[]> {
    const prefix = judgmentPrefix(evaluatorId);
    return [...this.judgments.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length, -".json".length));
  }

  async listAllJudgments(): Promise<{ judgments: VoiceJudgment[]; unreadable: number }> {
    return { judgments: [...this.judgments.values()], unreadable: 0 };
  }
}

/** Local-only durable implementation used exclusively with STORAGE=file. */
export class FileVoiceStorage implements VoiceStorage {
  private readonly root: string;
  constructor(root: string) { if (!root) throw new Error("LOCAL_STORAGE_DIR is required when STORAGE=file"); this.root = resolve(root, "voice"); }
  private path(...parts: string[]) { return join(this.root, ...parts); }
  async getManifest(): Promise<VoiceManifest | undefined> {
    try { return JSON.parse(await readFile(this.path("manifest.json"), "utf8")) as VoiceManifest; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async putManifest(manifest: VoiceManifest): Promise<void> { await mkdir(this.root, { recursive: true }); await writeFile(this.path("manifest.json"), JSON.stringify(manifest), { mode: 0o600 }); }
  async putJudgment(judgment: VoiceJudgment): Promise<{ created: boolean }> {
    const path = this.path("judgments", judgment.evaluator_id, `${judgment.comparison_id}.json`);
    await mkdir(resolve(path, ".."), { recursive: true });
    try { await writeFile(path, JSON.stringify(judgment), { flag: "wx", mode: 0o600 }); return { created: true }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return { created: false }; throw error; }
  }
  async listJudgmentKeys(evaluatorId: string): Promise<string[]> {
    try { const { readdir } = await import("node:fs/promises"); return (await readdir(this.path("judgments", evaluatorId))).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async listAllJudgments(): Promise<{ judgments: VoiceJudgment[]; unreadable: number }> {
    const { readdir } = await import("node:fs/promises");
    let evaluators: string[] = []; try { evaluators = await readdir(this.path("judgments")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const judgments: VoiceJudgment[] = []; let unreadable = 0;
    for (const evaluator of evaluators) for (const key of await this.listJudgmentKeys(evaluator)) try { const raw = await readFile(this.path("judgments", evaluator, `${key}.json`), "utf8"); const parsed = VoiceJudgmentSchema.safeParse(JSON.parse(raw)); if (parsed.success) judgments.push(parsed.data); else unreadable++; } catch { unreadable++; }
    return { judgments, unreadable };
  }
}

export class BlobVoiceStorage implements VoiceStorage {
  private async listAllBlobs(prefix: string): Promise<{ url: string; pathname: string }[]> {
    const blobs: { url: string; pathname: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor });
      blobs.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return blobs;
  }

  async getManifest(): Promise<VoiceManifest | undefined> {
    // list() + public-URL fetch, NOT get(): the authenticated get() endpoint
    // has been observed 403-blocking a valid token (2026-07-24 incident,
    // list() and public URLs unaffected), and the rest of this layer already
    // reads via list+fetch for exactly this class of reason.
    const blobs = await withRetry(() => list({ prefix: MANIFEST_PATH, limit: 1 }));
    const blob = blobs.blobs.find((b) => b.pathname === MANIFEST_PATH);
    if (!blob) return undefined;
    const raw = await withRetry(() => fetchJson<unknown>(blob.url));
    const parsed = VoiceManifestSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  async putManifest(manifest: VoiceManifest): Promise<void> {
    await withRetry(() =>
      put(MANIFEST_PATH, JSON.stringify(manifest), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      }),
    );
  }

  async putJudgment(judgment: VoiceJudgment): Promise<{ created: boolean }> {
    const pathname = judgmentPath(judgment.evaluator_id, judgment.comparison_id);
    const write = () =>
      put(pathname, JSON.stringify(judgment), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: "application/json",
      });
    try {
      await write();
      return { created: true };
    } catch (err) {
      if (isAlreadyExistsError(err)) return { created: false };
      try {
        await withRetry(write);
        return { created: true };
      } catch (err2) {
        // The first attempt may have transiently failed after actually writing
        // (or another writer beat us to it) — retries then see a real conflict.
        if (isAlreadyExistsError(err2)) return { created: false };
        throw err2;
      }
    }
  }

  async listJudgmentKeys(evaluatorId: string): Promise<string[]> {
    const prefix = judgmentPrefix(evaluatorId);
    const blobs = await this.listAllBlobs(prefix);
    return blobs.map((blob) => blob.pathname.slice(prefix.length, -".json".length));
  }

  async listAllJudgments(): Promise<{ judgments: VoiceJudgment[]; unreadable: number }> {
    const blobs = await this.listAllBlobs(JUDGMENTS_PREFIX);
    const judgments: VoiceJudgment[] = [];
    let unreadable = 0;
    for (let i = 0; i < blobs.length; i += LIST_CONCURRENCY) {
      const chunk = blobs.slice(i, i + LIST_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (blob) => {
          try {
            const raw = await withRetry(() => fetchJson<unknown>(blob.url), 3);
            const parsed = VoiceJudgmentSchema.safeParse(raw);
            return parsed.success ? parsed.data : undefined;
          } catch {
            return undefined;
          }
        }),
      );
      for (const result of results) {
        if (result) judgments.push(result);
        else unreadable++;
      }
    }
    return { judgments, unreadable };
  }
}

export function getVoiceStorage(): VoiceStorage {
  if (process.env.STORAGE === "file") return new FileVoiceStorage(process.env.LOCAL_STORAGE_DIR ?? "");
  if (process.env.STORAGE === "memory") return new MemoryVoiceStorage();
  if (process.env.BLOB_READ_WRITE_TOKEN) return new BlobVoiceStorage();
  throw new Error("storage misconfigured: set BLOB_READ_WRITE_TOKEN or STORAGE=memory");
}
