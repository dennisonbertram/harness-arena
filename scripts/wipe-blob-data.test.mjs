import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob", () => ({
  list: vi.fn(),
  del: vi.fn(),
}));

import { del, list } from "@vercel/blob";
import { wipeBlobData } from "./wipe-blob-data.mjs";

function blob(url) {
  return { url, pathname: url, size: 1, uploadedAt: new Date() };
}

describe("wipeBlobData", () => {
  beforeEach(() => {
    vi.mocked(list).mockReset();
    vi.mocked(del).mockReset();
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when BLOB_READ_WRITE_TOKEN is unset, without listing or deleting anything", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");

    await expect(wipeBlobData({ confirm: false })).rejects.toThrow("BLOB_READ_WRITE_TOKEN");
    expect(list).not.toHaveBeenCalled();
  });

  it("dry run lists matching blobs per prefix and calls no delete", async () => {
    vi.mocked(list).mockImplementation(async ({ prefix }) => ({
      blobs: prefix === "runs/" ? [blob("https://store.example/runs/r1.json")] : [],
      hasMore: false,
      cursor: undefined,
    }));

    const results = await wipeBlobData({ confirm: false });

    expect(del).not.toHaveBeenCalled();
    const runsResult = results.find((r) => r.prefix === "runs/");
    expect(runsResult.count).toBe(1);
    expect(runsResult.deleted).toBe(false);
  });

  it("--yes (confirm:true) deletes exactly the listed blobs per prefix, children first", async () => {
    const callOrder = [];
    vi.mocked(list).mockImplementation(async ({ prefix }) => {
      callOrder.push(`list:${prefix}`);
      const byPrefix = {
        "events/": [blob("https://store.example/events/r1/1.json")],
        "traces/": [blob("https://store.example/traces/r1/t1.txt")],
        "runs/": [blob("https://store.example/runs/r1.json")],
        "submissions/": [blob("https://store.example/submissions/s1.json")],
      };
      return { blobs: byPrefix[prefix] ?? [], hasMore: false, cursor: undefined };
    });
    vi.mocked(del).mockImplementation(async (urls) => {
      callOrder.push(`del:${Array.isArray(urls) ? urls.length : 1}`);
    });

    const results = await wipeBlobData({ confirm: true });

    // Children (events, traces) delete before parents (runs, submissions).
    expect(callOrder).toEqual([
      "list:events/",
      "del:1",
      "list:traces/",
      "del:1",
      "list:runs/",
      "del:1",
      "list:submissions/",
      "del:1",
    ]);
    expect(results.every((r) => r.deleted)).toBe(true);
    expect(results.reduce((sum, r) => sum + r.count, 0)).toBe(4);
  });

  it("does not call del for a prefix with zero matching blobs, even with confirm:true", async () => {
    vi.mocked(list).mockResolvedValue({ blobs: [], hasMore: false, cursor: undefined });

    await wipeBlobData({ confirm: true });

    expect(del).not.toHaveBeenCalled();
  });

  it("a delete failure on one prefix is reported but does not stop the remaining prefixes (idempotent re-run)", async () => {
    vi.mocked(list).mockImplementation(async ({ prefix }) => ({
      blobs: [blob(`https://store.example/${prefix}x.json`)],
      hasMore: false,
      cursor: undefined,
    }));
    vi.mocked(del).mockImplementation(async (urls) => {
      if (urls[0].includes("/traces/")) throw new Error("blob store unavailable");
    });

    const results = await wipeBlobData({ confirm: true });

    const traces = results.find((r) => r.prefix === "traces/");
    expect(traces.deleted).toBe(false);
    expect(traces.error).toContain("unavailable");
    // Every other prefix still got its delete attempt.
    expect(results.filter((r) => r.prefix !== "traces/").every((r) => r.deleted)).toBe(true);
  });
});
