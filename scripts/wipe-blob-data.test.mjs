import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob", () => ({
  list: vi.fn(),
  del: vi.fn(),
}));

import { del, list } from "@vercel/blob";

let wipeBlobData;

function blob(url) {
  return { url, pathname: url, size: 1, uploadedAt: new Date() };
}

describe("wipeBlobData", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(list).mockReset();
    vi.mocked(del).mockReset();
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test_secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function loadWipeBlobData() {
    ({ wipeBlobData } = await import("./wipe-blob-data.mjs"));
  }

  it("throws when BLOB_READ_WRITE_TOKEN is unset, without listing or deleting anything", async () => {
    await loadWipeBlobData();
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");

    await expect(wipeBlobData({ confirm: false })).rejects.toThrow("BLOB_READ_WRITE_TOKEN");
    expect(list).not.toHaveBeenCalled();
  });

  it("dry run lists matching blobs per prefix and calls no delete", async () => {
    await loadWipeBlobData();
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
    await loadWipeBlobData();
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
    await loadWipeBlobData();
    vi.mocked(list).mockResolvedValue({ blobs: [], hasMore: false, cursor: undefined });

    await wipeBlobData({ confirm: true });

    expect(del).not.toHaveBeenCalled();
  });

  it("a delete failure on one prefix is reported but does not stop the remaining prefixes (idempotent re-run)", async () => {
    await loadWipeBlobData();
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

  it("a list() failure on one prefix is reported but does not stop the remaining prefixes", async () => {
    await loadWipeBlobData();
    vi.mocked(list).mockImplementation(async ({ prefix }) => {
      if (prefix === "runs/") throw new Error("list timed out");
      return { blobs: [blob(`https://store.example/${prefix}x.json`)], hasMore: false, cursor: undefined };
    });
    vi.mocked(del).mockResolvedValue(undefined);

    const results = await wipeBlobData({ confirm: true });

    const runs = results.find((r) => r.prefix === "runs/");
    expect(runs.deleted).toBe(false);
    expect(runs.count).toBe(0);
    expect(runs.error).toContain("timed out");
    // Every other prefix (listed before and after runs/) still got attempted.
    expect(results.filter((r) => r.prefix !== "runs/").every((r) => r.deleted)).toBe(true);
  });

  it("chunks del() calls at 100 URLs so a large prefix isn't deleted in one unbounded request", async () => {
    await loadWipeBlobData();
    const manyBlobs = Array.from({ length: 250 }, (_, i) => blob(`https://store.example/events/${i}.json`));
    vi.mocked(list).mockImplementation(async ({ prefix }) => ({
      blobs: prefix === "events/" ? manyBlobs : [],
      hasMore: false,
      cursor: undefined,
    }));
    const delCalls = [];
    vi.mocked(del).mockImplementation(async (urls) => {
      delCalls.push(urls.length);
    });

    const results = await wipeBlobData({ confirm: true });

    // 250 blobs at a 100-URL batch size -> three calls of 100, 100, 50.
    expect(delCalls).toEqual([100, 100, 50]);
    const events = results.find((r) => r.prefix === "events/");
    expect(events.deleted).toBe(true);
    expect(events.count).toBe(250);
  });

  it("follows paginated list cursors before deleting the complete prefix", async () => {
    await loadWipeBlobData();
    vi.mocked(list).mockImplementation(async ({ prefix, cursor }) => {
      if (prefix !== "events/") return { blobs: [], hasMore: false, cursor: undefined };
      if (!cursor) return { blobs: [blob("https://store.example/events/first.json")], hasMore: true, cursor: "next" };
      return { blobs: [blob("https://store.example/events/second.json")], hasMore: false, cursor: undefined };
    });
    vi.mocked(del).mockResolvedValue(undefined);

    const results = await wipeBlobData({ confirm: true });

    expect(list).toHaveBeenNthCalledWith(1, { prefix: "events/", cursor: undefined, access: "public" });
    expect(list).toHaveBeenNthCalledWith(2, { prefix: "events/", cursor: "next", access: "public" });
    expect(del).toHaveBeenCalledWith([
      "https://store.example/events/first.json",
      "https://store.example/events/second.json",
    ], { access: "public" });
    expect(results[0]).toMatchObject({ prefix: "events/", count: 2, deleted: true });
  });

  it("prints the dry-run CLI summary when invoked as the entrypoint", async () => {
    const originalArgv = process.argv;
    const scriptPath = new URL("./wipe-blob-data.mjs", import.meta.url).pathname;
    process.argv = [process.execPath, scriptPath];
    vi.mocked(list).mockImplementation(async ({ prefix }) => ({
      blobs: prefix === "runs/" ? [blob("https://store.example/runs/r1.json")] : [],
      hasMore: false,
      cursor: undefined,
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await import("./wipe-blob-data.mjs");
    process.argv = originalArgv;

    expect(del).not.toHaveBeenCalled();
    expect(log.mock.calls.flat()).toEqual(expect.arrayContaining([
      "Would delete (dry run — pass --yes to actually delete):",
      expect.stringContaining("runs/: 1 blob(s) (e.g. https://store.example/runs/r1.json)"),
      "\n1 blob(s) total. Re-run with --yes to delete.",
    ]));
  });

  it("prints the empty-store confirmation summary from the CLI", async () => {
    const originalArgv = process.argv;
    const scriptPath = new URL("./wipe-blob-data.mjs", import.meta.url).pathname;
    process.argv = [process.execPath, scriptPath, "--yes"];
    vi.mocked(list).mockResolvedValue({ blobs: [], hasMore: false, cursor: undefined });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await import("./wipe-blob-data.mjs");
    process.argv = originalArgv;

    expect(del).not.toHaveBeenCalled();
    expect(log.mock.calls.flat()).toEqual(expect.arrayContaining(["Deleting:", "Nothing to delete."]));
  });

  it("reports CLI failures and exits nonzero after attempting every prefix", async () => {
    const originalArgv = process.argv;
    const scriptPath = new URL("./wipe-blob-data.mjs", import.meta.url).pathname;
    process.argv = [process.execPath, scriptPath, "--yes"];
    vi.mocked(list).mockImplementation(async ({ prefix }) => {
      if (prefix === "events/") throw new Error("permission denied");
      return { blobs: [], hasMore: false, cursor: undefined };
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined);

    await import("./wipe-blob-data.mjs");
    process.argv = originalArgv;

    expect(list).toHaveBeenCalledTimes(4);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("events/"));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
