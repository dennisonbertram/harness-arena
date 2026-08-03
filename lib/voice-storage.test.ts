import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, list, put } from "@vercel/blob";
import { BlobVoiceStorage, FileVoiceStorage, getVoiceStorage, MemoryVoiceStorage } from "./voice-storage";
import type { VoiceJudgment, VoiceManifest } from "./voice-types";

vi.mock("@vercel/blob", () => ({
  get: vi.fn(),
  put: vi.fn(),
  list: vi.fn(),
}));

function makeJudgment(overrides: Partial<VoiceJudgment> = {}): VoiceJudgment {
  return {
    comparison_id: "resp-a_resp-b",
    evaluator_id: "eval-1",
    prompt_id: "prompt-1",
    response_a_id: "resp-a",
    response_b_id: "resp-b",
    outcome: "a",
    play_counts: { prompt: 1, a: 1, b: 1 },
    time_to_judgment_ms: 3000,
    created_at: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

function makeManifest(overrides: Partial<VoiceManifest> = {}): VoiceManifest {
  return {
    version: "1",
    created_at: "2026-07-24T00:00:00.000Z",
    models: [],
    prompts: [],
    responses: [],
    ...overrides,
  };
}

describe("MemoryVoiceStorage", () => {
  it("putJudgment: first write returns created:true, duplicate key returns created:false with content unchanged", async () => {
    const storage = new MemoryVoiceStorage();
    const first = await storage.putJudgment(makeJudgment({ outcome: "a" }));
    const second = await storage.putJudgment(makeJudgment({ outcome: "b" }));

    expect(first).toEqual({ created: true });
    expect(second).toEqual({ created: false });

    const { judgments } = await storage.listAllJudgments();
    expect(judgments).toHaveLength(1);
    expect(judgments[0].outcome).toBe("a");
  });

  it("listJudgmentKeys returns only the given evaluator's comparison IDs", async () => {
    const storage = new MemoryVoiceStorage();
    await storage.putJudgment(makeJudgment({ evaluator_id: "eval-1", comparison_id: "c1" }));
    await storage.putJudgment(makeJudgment({ evaluator_id: "eval-1", comparison_id: "c2" }));
    await storage.putJudgment(makeJudgment({ evaluator_id: "eval-2", comparison_id: "c3" }));

    const keys = await storage.listJudgmentKeys("eval-1");
    expect(keys.sort()).toEqual(["c1", "c2"]);
  });

  it("listAllJudgments reports unreadable:0", async () => {
    const storage = new MemoryVoiceStorage();
    await storage.putJudgment(makeJudgment());
    const { unreadable } = await storage.listAllJudgments();
    expect(unreadable).toBe(0);
  });
});

describe("FileVoiceStorage", () => {
  let root: string;
  let outside: string | undefined;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "voice-file-storage-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); if (outside) await rm(outside, { recursive: true, force: true }); outside = undefined; });

  it("atomically writes and schema-validates manifests", async () => {
    const storage = new FileVoiceStorage(root);
    await Promise.all(Array.from({ length: 10 }, (_, index) => storage.putManifest(makeManifest({ created_at: `2026-07-24T00:00:0${index}.000Z` }))));
    expect((await storage.getManifest())?.version).toBe("1");
    expect((await readdir(join(root, "voice"))).filter((name) => name.includes(".tmp"))).toEqual([]);
    await writeFile(join(root, "voice", "manifest.json"), JSON.stringify({ version: "2" }));
    await expect(storage.getManifest()).rejects.toThrow(/manifest|schema|invalid/i);
  });

  it("publishes write-once judgments only after a complete temp file and recovers after interruption", async () => {
    const FaultInjectableFileVoiceStorage = FileVoiceStorage as unknown as new (
      storageRoot: string,
      options: { beforeJudgmentPublish?: () => void | Promise<void> },
    ) => FileVoiceStorage;
    const interrupted = new FaultInjectableFileVoiceStorage(root, {
      beforeJudgmentPublish: () => { throw new Error("injected judgment publication interruption"); },
    });
    const path = join(root, "voice", "judgments", "eval-1", "resp-a_resp-b.json");

    await expect(interrupted.putJudgment(makeJudgment())).rejects.toThrow(/injected judgment publication interruption/);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const retry = new FileVoiceStorage(root);
    await expect(retry.putJudgment(makeJudgment({ outcome: "a" }))).resolves.toEqual({ created: true });
    await expect(retry.putJudgment(makeJudgment({ outcome: "b" }))).resolves.toEqual({ created: false });
    expect(JSON.parse(await readFile(path, "utf8")).outcome).toBe("a");
  });

  it.each([".", "..", "../escape", "a/b", "a\\b", "%2e%2e%2fescape"])("rejects unsafe judgment/evaluator path %j", async (part) => {
    const storage = new FileVoiceStorage(root);
    await expect(storage.putJudgment(makeJudgment({ evaluator_id: part }))).rejects.toThrow(/path segment/);
    await expect(storage.putJudgment(makeJudgment({ comparison_id: part }))).rejects.toThrow(/path segment/);
    await expect(storage.listJudgmentKeys(part)).rejects.toThrow(/path segment/);
  });

  it("rejects audio symlinks escaping the local storage root", async () => {
    const outside = join(root, "..", "outside-audio.wav");
    await writeFile(outside, "secret");
    await mkdir(join(root, "voice", "audio", "prompts"), { recursive: true });
    await symlink(outside, join(root, "voice", "audio", "prompts", "prompt-1.wav"));
    try { await expect(new FileVoiceStorage(root).getAudioBytes("prompts", "prompt-1")).rejects.toThrow(/path|symlink|storage/i); }
    finally { await rm(outside, { force: true }); }
  });

  it("rejects a symlink component before manifest reads or atomic writes and preserves the external target", async () => {
    outside = await mkdtemp(join(tmpdir(), "voice-file-storage-outside-"));
    const original = JSON.stringify(makeManifest({ created_at: "2026-07-24T00:00:00.000Z" }));
    await writeFile(join(outside, "manifest.json"), original);
    await symlink(outside, join(root, "voice"));
    const storage = new FileVoiceStorage(root);

    const readOutcome = await storage.getManifest().then(() => "resolved", () => "rejected");
    const writeOutcome = await storage.putManifest(makeManifest({ created_at: "2026-07-24T00:00:09.000Z" })).then(() => "resolved", () => "rejected");
    const externalValue = await readFile(join(outside, "manifest.json"), "utf8").catch(() => "missing");
    expect({ readOutcome, writeOutcome, externalValue }).toEqual({ readOutcome: "rejected", writeOutcome: "rejected", externalValue: original });
  });
});

describe("BlobVoiceStorage (contract, @vercel/blob mocked)", () => {
  beforeEach(() => {
    vi.mocked(get).mockReset();
    vi.mocked(put).mockReset();
    vi.mocked(list).mockReset();
  });

  it("putJudgment writes a write-once blob at voice/judgments/<evaluatorId>/<comparisonId>.json", async () => {
    const storage = new BlobVoiceStorage();
    vi.mocked(put).mockResolvedValueOnce({ url: "https://blob.example/voice/judgments/eval-1/c1.json" } as never);

    const result = await storage.putJudgment(makeJudgment({ evaluator_id: "eval-1", comparison_id: "c1" }));

    expect(result).toEqual({ created: true });
    expect(put).toHaveBeenCalledWith("voice/judgments/eval-1/c1.json", expect.any(String), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/json",
    });
  });

  it("putJudgment returns created:false on an 'already exists' conflict without retrying", async () => {
    const storage = new BlobVoiceStorage();
    vi.mocked(put).mockRejectedValue(new Error("This blob already exists"));

    const result = await storage.putJudgment(makeJudgment());

    expect(result).toEqual({ created: false });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it(
    "putJudgment on a non-conflict error retries and ultimately rethrows, never returning created:false",
    async () => {
      const storage = new BlobVoiceStorage();
      vi.mocked(put).mockRejectedValue(new Error("network blip"));

      await expect(storage.putJudgment(makeJudgment())).rejects.toThrow("network blip");
      // 1 initial attempt (not retried, conflict-checked) + withRetry's default 4 attempts.
      expect(put).toHaveBeenCalledTimes(5);
    },
    10000,
  );

  it(
    "putJudgment resolves created:false (not a throw) when the initial write fails transiently but the retry recovery then hits an 'already exists' conflict",
    async () => {
      const storage = new BlobVoiceStorage();
      vi.mocked(put)
        .mockRejectedValueOnce(new Error("network blip"))
        .mockRejectedValue(new Error("This blob already exists"));

      const result = await storage.putJudgment(makeJudgment());

      expect(result).toEqual({ created: false });
      // 1 initial attempt (transient) + withRetry's default 4 attempts (all "already exists").
      expect(put).toHaveBeenCalledTimes(5);
    },
    10000,
  );

  it("listJudgmentKeys returns only the given evaluator's comparison IDs and never fetches judgment bodies", async () => {
    const storage = new BlobVoiceStorage();
    vi.mocked(list).mockResolvedValueOnce({
      blobs: [
        { url: "https://blob.example/voice/judgments/eval-1/c1.json", pathname: "voice/judgments/eval-1/c1.json" },
        { url: "https://blob.example/voice/judgments/eval-1/c2.json", pathname: "voice/judgments/eval-1/c2.json" },
      ],
      hasMore: false,
    } as never);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const keys = await storage.listJudgmentKeys("eval-1");

    expect(keys.sort()).toEqual(["c1", "c2"]);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ prefix: "voice/judgments/eval-1/" }));
    expect(get).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("listAllJudgments skips a judgment that fails schema validation, counts it as unreadable, and keeps the rest", async () => {
    const storage = new BlobVoiceStorage();
    vi.mocked(list).mockResolvedValueOnce({
      blobs: [
        { url: "https://blob.example/voice/judgments/eval-1/c1.json", pathname: "voice/judgments/eval-1/c1.json" },
        { url: "https://blob.example/voice/judgments/eval-2/c2.json", pathname: "voice/judgments/eval-2/c2.json" },
      ],
      hasMore: false,
    } as never);
    vi.mocked(get)
      .mockResolvedValueOnce({ statusCode: 200, stream: new Response(JSON.stringify(makeJudgment({ comparison_id: "c1" }))).body } as never)
      .mockResolvedValue({ statusCode: 200, stream: new Response(JSON.stringify({ not: "a judgment" })).body } as never);

    const { judgments, unreadable } = await storage.listAllJudgments();

    expect(judgments.map((j) => j.comparison_id)).toEqual(["c1"]);
    expect(unreadable).toBe(1);

  });

  it("getManifest returns undefined when the stored content fails manifest schema validation", async () => {
    const storage = new BlobVoiceStorage();
    vi.mocked(list).mockResolvedValueOnce({
      blobs: [{ pathname: "voice/manifest.json", url: "https://blob.example/voice/manifest.json" }],
      hasMore: false,
    } as never);
    vi.mocked(get).mockResolvedValue({ statusCode: 200, stream: new Response(JSON.stringify({ not: "a manifest" })).body } as never);

    const manifest = await storage.getManifest();

    expect(manifest).toBeUndefined();
  });

  it("getManifest returns undefined (without fetching) when no manifest blob exists", async () => {
    const storage = new BlobVoiceStorage();
    vi.mocked(list).mockResolvedValueOnce({ blobs: [], hasMore: false } as never);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const manifest = await storage.getManifest();

    expect(manifest).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("getManifest reads via the configured authenticated Blob access mode", async () => {
    const storage = new BlobVoiceStorage();
    vi.mocked(list).mockResolvedValueOnce({
      blobs: [{ pathname: "voice/manifest.json", url: "https://blob.example/voice/manifest.json" }],
      hasMore: false,
    } as never);
    vi.mocked(get).mockResolvedValue({ statusCode: 200, stream: new Response(JSON.stringify(makeManifest())).body } as never);

    const manifest = await storage.getManifest();

    expect(manifest?.version).toBe("1");
    expect(vi.mocked(get)).toHaveBeenCalledWith("voice/manifest.json", { access: "public" });
  });

  it("rejects a valid manifest JSON response whose observed chunks exceed the ceiling", async () => {
    const storage = new BlobVoiceStorage();
    vi.mocked(list).mockResolvedValueOnce({
      blobs: [{ pathname: "voice/manifest.json", url: "https://blob.example/voice/manifest.json" }],
      hasMore: false,
    } as never);
    const oversized = JSON.stringify({ ...makeManifest(), ignored_padding: "x".repeat(1024 * 1024 + 1) });
    vi.mocked(get).mockResolvedValue({ statusCode: 200, stream: new Response(oversized).body } as never);
    await expect(storage.getManifest()).rejects.toThrow(/limit|large|bytes/i);
  });

  it("counts an oversized judgment Blob JSON response as unreadable", async () => {
    const storage = new BlobVoiceStorage();
    vi.mocked(list).mockResolvedValueOnce({
      blobs: [{ pathname: "voice/judgments/eval-1/c1.json", url: "https://blob.example/c1.json" }],
      hasMore: false,
    } as never);
    const oversized = JSON.stringify({ ...makeJudgment(), ignored_padding: "x".repeat(1024 * 1024 + 1) });
    vi.mocked(get).mockResolvedValue({ statusCode: 200, stream: new Response(oversized).body } as never);
    await expect(storage.listAllJudgments()).resolves.toEqual({ judgments: [], unreadable: 1 });
  });

  it("putManifest writes voice/manifest.json with allowOverwrite:true", async () => {
    const storage = new BlobVoiceStorage();
    vi.mocked(put).mockResolvedValueOnce({ url: "https://blob.example/voice/manifest.json" } as never);

    await storage.putManifest(makeManifest());

    expect(put).toHaveBeenCalledWith("voice/manifest.json", expect.any(String), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
  });
});

describe("getVoiceStorage factory", () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  const originalStorage = process.env.STORAGE;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalToken === undefined) {
      delete process.env.BLOB_READ_WRITE_TOKEN;
    } else {
      process.env.BLOB_READ_WRITE_TOKEN = originalToken;
    }
    if (originalStorage === undefined) {
      delete process.env.STORAGE;
    } else {
      process.env.STORAGE = originalStorage;
    }
  });

  it("returns MemoryVoiceStorage when STORAGE=memory, even if BLOB_READ_WRITE_TOKEN is set", () => {
    process.env.STORAGE = "memory";
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_token";
    expect(getVoiceStorage()).toBeInstanceOf(MemoryVoiceStorage);
  });

  it("returns BlobVoiceStorage when BLOB_READ_WRITE_TOKEN is set and STORAGE is not memory", () => {
    delete process.env.STORAGE;
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_token";
    expect(getVoiceStorage()).toBeInstanceOf(BlobVoiceStorage);
  });

  it("eagerly rejects mixed isolated Development store identity", () => {
    delete process.env.STORAGE; process.env.BLOB_READ_WRITE_TOKEN = "rw";
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA"); vi.stubEnv("HARNESS_BLOB_STORE_ID", "store_dev"); vi.stubEnv("BLOB_STORE_ID", "store_other");
    expect(() => getVoiceStorage()).toThrow("Blob store identity mismatch");
  });

  it("throws when neither STORAGE=memory nor BLOB_READ_WRITE_TOKEN is set", () => {
    delete process.env.STORAGE;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    expect(() => getVoiceStorage()).toThrow(
      "storage misconfigured: set BLOB_READ_WRITE_TOKEN or STORAGE=memory",
    );
  });
});
