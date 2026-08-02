import { list, put } from "@vercel/blob";
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
  listOpsRecords(prefix: string, options: { limit: number; cursor?: string }): Promise<{ records: { pathname: string }[]; nextCursor?: string; partial: string[] }>;
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
  async listOpsRecords(prefix: string, options: { limit: number; cursor?: string }) { const paths=[...(this.manifest?[MANIFEST_PATH]:[]),...this.judgments.keys()].filter((p)=>p.startsWith(prefix)).sort();const offset=Number(options.cursor??0),records=paths.slice(offset,offset+options.limit).map((pathname)=>({pathname}));return {records,nextCursor:offset+records.length<paths.length?String(offset+records.length):undefined,partial:[]}; }

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

export class BlobVoiceStorage implements VoiceStorage {
  async listOpsRecords(prefix: string, options: { limit: number; cursor?: string }) { try { const page=await withRetry(()=>list({prefix,limit:options.limit,cursor:options.cursor})); return {records:page.blobs.map((b)=>({pathname:b.pathname})),nextCursor:page.hasMore?page.cursor:undefined,partial:[]}; } catch { return {records:[],partial:[prefix]}; } }
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
  if (process.env.STORAGE === "memory") return new MemoryVoiceStorage();
  if (process.env.BLOB_READ_WRITE_TOKEN) return new BlobVoiceStorage();
  throw new Error("storage misconfigured: set BLOB_READ_WRITE_TOKEN or STORAGE=memory");
}
