import { beforeEach, describe, expect, it, vi } from "vitest";
const blob = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock("@vercel/blob", () => blob);
import { BlobOpsReadAdapter } from "./ops-read-adapter";

const metadata = (size: number) => ({ pathname: "traces/r/t/log.txt", size, uploadedAt: new Date("2026-08-02T00:00:00.000Z"), etag: "etag", url: "https://blob.test/a?token=secret", downloadUrl: "https://blob.test/a?token=secret" });
describe("Blob ops read adapter", () => {
  beforeEach(() => vi.clearAllMocks());
  it("preserves storage pagination and exposes metadata without signed URLs", async () => {
    blob.list.mockResolvedValue({ blobs: [metadata(12)], hasMore: true, cursor: "blob-next" });
    await expect(new BlobOpsReadAdapter().listPage({ prefix: "traces/", limit: 1 })).resolves.toEqual({ records: [{ pathname: "traces/r/t/log.txt", size: 12, uploaded_at: "2026-08-02T00:00:00.000Z", etag: "etag" }], has_more: true, cursor: "blob-next" });
  });
  it("refuses oversized content before get and distinguishes transient failures", async () => {
    blob.list.mockResolvedValueOnce({ blobs: [metadata(20)], hasMore: false });
    await expect(new BlobOpsReadAdapter().read({ pathname: "traces/r/t/log.txt", maxBytes: 10, timeoutMs: 100 })).resolves.toMatchObject({ status: "too_large", size: 20 });
    expect(blob.get).not.toHaveBeenCalled();
    blob.list.mockResolvedValue({ blobs: [metadata(2)], hasMore: false }); blob.get.mockRejectedValue(new Error("reset"));
    await expect(new BlobOpsReadAdapter().read({ pathname: "traces/r/t/log.txt", maxBytes: 10, timeoutMs: 100 })).resolves.toEqual({ status: "transient", error: "read_failed" });
    expect(blob.get).toHaveBeenCalledTimes(2);
  });
});
