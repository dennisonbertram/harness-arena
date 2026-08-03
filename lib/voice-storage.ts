import { get, list, put } from "@vercel/blob";
import { blobCommandOptions } from "./blob-access";
import { readBlobJson } from "./blob-read.mjs";
import { readBoundedStream } from "./bounded-stream";
import { mkdir as nodeMkdir, readFile as nodeReadFile, readdir as nodeReaddir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertLocalFileStorageAllowed, LocalStorageReadError, safeStoragePart } from "./file-storage";
import { assertSafeStoragePath, atomicCreateFile, atomicWriteFile } from "./file-storage-lock.mjs";
import { withRetry } from "./storage";
import { VoiceJudgmentSchema, VoiceManifestSchema } from "./voice-types";
import type { VoiceJudgment, VoiceManifest } from "./voice-types";
import { BLOB_PATHS } from "./blob-paths.mjs";

const MANIFEST_PATH = BLOB_PATHS.voiceManifest;
const JUDGMENTS_PREFIX = BLOB_PATHS.voiceJudgments;
const LIST_CONCURRENCY = 20;
const mkdir = (path: string, options: Parameters<typeof nodeMkdir>[1]) => nodeMkdir(/* turbopackIgnore: true */ path, options);
function readFile(path: string): Promise<Buffer>;
function readFile(path: string, encoding: "utf8"): Promise<string>;
function readFile(path: string, encoding?: "utf8"): Promise<string | Buffer> {
  return encoding
    ? nodeReadFile(/* turbopackIgnore: true */ path, encoding)
    : nodeReadFile(/* turbopackIgnore: true */ path) as Promise<Buffer>;
}
const readdir = (path: string) => nodeReaddir(/* turbopackIgnore: true */ path);
export type VoiceAudioKind = "prompts" | "responses";

function audioPath(kind: VoiceAudioKind, id: string): string {
  return `${kind === "prompts" ? BLOB_PATHS.voiceAudioPrompts : BLOB_PATHS.voiceAudioResponses}${id}.wav`;
}

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
  getAudioBytes(kind: VoiceAudioKind, id: string): Promise<Buffer | null>;
}

export class MemoryVoiceStorage implements VoiceStorage {
  private manifest: VoiceManifest | undefined;
  private judgments = new Map<string, VoiceJudgment>();
  private audio = new Map<string, Buffer>();

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
  async getAudioBytes(kind: VoiceAudioKind, id: string): Promise<Buffer | null> { return this.audio.get(audioPath(kind, id)) ?? null; }
}

/** Local-only durable implementation used exclusively with STORAGE=file. */
export class FileVoiceStorage implements VoiceStorage {
  private readonly storageRoot: string;
  private readonly root: string;
  private readonly beforeJudgmentPublish?: () => void | Promise<void>;
  constructor(root: string, { beforeJudgmentPublish }: { beforeJudgmentPublish?: () => void | Promise<void> } = {}) {
    assertLocalFileStorageAllowed();
    if (!root) throw new Error("LOCAL_STORAGE_DIR is required when STORAGE=file");
    this.storageRoot = resolve(root);
    this.root = resolve(root, "voice");
    this.beforeJudgmentPublish = beforeJudgmentPublish;
  }
  private path(...parts: string[]) { return join(this.root, ...parts); }
  async getManifest(): Promise<VoiceManifest | undefined> {
    const path = this.path("manifest.json");
    await assertSafeStoragePath(this.storageRoot, path);
    try { return VoiceManifestSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new LocalStorageReadError(path, error); }
  }
  async putManifest(manifest: VoiceManifest): Promise<void> { await atomicWriteFile(this.path("manifest.json"), JSON.stringify(VoiceManifestSchema.parse(manifest)), 0o600, this.storageRoot); }
  async putJudgment(judgment: VoiceJudgment): Promise<{ created: boolean }> {
    const valid = VoiceJudgmentSchema.parse(judgment);
    const path = this.path("judgments", safeStoragePart(valid.evaluator_id), `${safeStoragePart(valid.comparison_id)}.json`);
    await assertSafeStoragePath(this.storageRoot, path);
    await mkdir(resolve(path, ".."), { recursive: true });
    await assertSafeStoragePath(this.storageRoot, path);
    try {
      await atomicCreateFile(path, JSON.stringify(valid), 0o600, this.storageRoot, { beforePublish: this.beforeJudgmentPublish });
      return { created: true };
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return { created: false }; throw error; }
  }
  async listJudgmentKeys(evaluatorId: string): Promise<string[]> {
    const evaluator = safeStoragePart(evaluatorId);
    const directory = this.path("judgments", evaluator);
    await assertSafeStoragePath(this.storageRoot, directory);
    try { return (await readdir(directory)).filter((name) => name.endsWith(".json")).map((name) => safeStoragePart(name.slice(0, -5))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async listAllJudgments(): Promise<{ judgments: VoiceJudgment[]; unreadable: number }> {
    const judgmentsRoot = this.path("judgments");
    await assertSafeStoragePath(this.storageRoot, judgmentsRoot);
    let evaluators: string[] = []; try { evaluators = await readdir(judgmentsRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const judgments: VoiceJudgment[] = []; let unreadable = 0;
    for (const evaluatorName of evaluators) {
      const evaluator = safeStoragePart(evaluatorName);
      for (const key of await this.listJudgmentKeys(evaluator)) {
        const path = this.path("judgments", evaluator, `${key}.json`);
        await assertSafeStoragePath(this.storageRoot, path);
        try { const raw = await readFile(path, "utf8"); const parsed = VoiceJudgmentSchema.safeParse(JSON.parse(raw)); if (parsed.success) judgments.push(parsed.data); else unreadable++; } catch { unreadable++; }
      }
    }
    return { judgments, unreadable };
  }
  async getAudioBytes(kind: VoiceAudioKind, id: string): Promise<Buffer | null> {
    const path = this.path("audio", kind, `${safeStoragePart(id)}.wav`); await assertSafeStoragePath(this.storageRoot, path);
    try { return await readFile(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
}

export class BlobVoiceStorage implements VoiceStorage {
  private async listAllBlobs(prefix: string): Promise<{ pathname: string }[]> {
    const blobs: { pathname: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(blobCommandOptions({ prefix, cursor }));
      blobs.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return blobs;
  }

  async getManifest(): Promise<VoiceManifest | undefined> {
    const blobs = await withRetry(() => list(blobCommandOptions({ prefix: MANIFEST_PATH, limit: 1 })));
    const blob = blobs.blobs.find((b) => b.pathname === MANIFEST_PATH);
    if (!blob) return undefined;
    const raw = await withRetry(() => readBlobJson(blob.pathname));
    if (raw === undefined) return undefined;
    const parsed = VoiceManifestSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  async putManifest(manifest: VoiceManifest): Promise<void> {
    await withRetry(() =>
      put(MANIFEST_PATH, JSON.stringify(manifest), blobCommandOptions({
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      })),
    );
  }

  async putJudgment(judgment: VoiceJudgment): Promise<{ created: boolean }> {
    const pathname = judgmentPath(judgment.evaluator_id, judgment.comparison_id);
    const write = () =>
      put(pathname, JSON.stringify(judgment), blobCommandOptions({
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: "application/json",
      }));
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
            const raw = await withRetry(() => readBlobJson(blob.pathname, { required: true }), 3);
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
  async getAudioBytes(kind: VoiceAudioKind, id: string): Promise<Buffer | null> {
    const response = await get(audioPath(kind, id), blobCommandOptions());
    if (!response || response.statusCode !== 200 || !response.stream) return null;
    return readBoundedStream(response.stream, 12 * 1024 * 1024);
  }
}

export function getVoiceStorage(): VoiceStorage {
  if (process.env.STORAGE === "file") return new FileVoiceStorage(process.env.LOCAL_STORAGE_DIR ?? "");
  if (process.env.STORAGE === "memory") return new MemoryVoiceStorage();
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_OIDC_TOKEN) { blobCommandOptions(); return new BlobVoiceStorage(); }
  throw new Error("storage misconfigured: set BLOB_READ_WRITE_TOKEN or STORAGE=memory");
}
