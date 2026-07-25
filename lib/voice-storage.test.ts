import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get, list, put } from "@vercel/blob";
import { BlobVoiceStorage, getVoiceStorage, MemoryVoiceStorage } from "./voice-storage";
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
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(makeJudgment({ comparison_id: "c1" })) })
        .mockResolvedValue({ ok: true, text: async () => JSON.stringify({ not: "a judgment" }) }),
    );

    const { judgments, unreadable } = await storage.listAllJudgments();

    expect(judgments.map((j) => j.comparison_id)).toEqual(["c1"]);
    expect(unreadable).toBe(1);

    vi.unstubAllGlobals();
  });

  it("getManifest returns undefined when the stored content fails manifest schema validation", async () => {
    const storage = new BlobVoiceStorage();
    vi.mocked(list).mockResolvedValueOnce({
      blobs: [{ pathname: "voice/manifest.json", url: "https://blob.example/voice/manifest.json" }],
      hasMore: false,
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ not: "a manifest" }), { status: 200 })),
    );

    const manifest = await storage.getManifest();

    expect(manifest).toBeUndefined();
    vi.unstubAllGlobals();
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

  it("getManifest reads via list + public URL fetch, never the authenticated get() endpoint", async () => {
    const storage = new BlobVoiceStorage();
    vi.mocked(list).mockResolvedValueOnce({
      blobs: [{ pathname: "voice/manifest.json", url: "https://blob.example/voice/manifest.json" }],
      hasMore: false,
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(makeManifest()), { status: 200 })),
    );

    const manifest = await storage.getManifest();

    expect(manifest?.version).toBe("1");
    expect(vi.mocked(get)).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
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

  it("throws when neither STORAGE=memory nor BLOB_READ_WRITE_TOKEN is set", () => {
    delete process.env.STORAGE;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    expect(() => getVoiceStorage()).toThrow(
      "storage misconfigured: set BLOB_READ_WRITE_TOKEN or STORAGE=memory",
    );
  });
});
