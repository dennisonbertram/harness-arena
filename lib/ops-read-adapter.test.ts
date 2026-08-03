import { beforeEach, describe, expect, it, vi } from "vitest";
const blob = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock("@vercel/blob", () => blob);
import { BlobOpsReadAdapter } from "./ops-read-adapter";

const metadata = (size: number) => ({ pathname: "traces/r/t/log.txt", size, uploadedAt: new Date("2026-08-02T00:00:00.000Z"), etag: "etag", url: "https://blob.test/a?token=secret", downloadUrl: "https://blob.test/a?token=secret" });
describe("Blob ops read adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test_secret");
  });
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
  it("passes abort signals and retries metadata-present null gets before declaring transient", async () => {
    blob.list.mockResolvedValue({ blobs: [metadata(2)], hasMore: false });
    blob.get.mockResolvedValueOnce(null).mockResolvedValueOnce({ statusCode: 200, stream: new Response("ok").body });
    await expect(new BlobOpsReadAdapter().read({ pathname: "traces/r/t/log.txt", maxBytes: 10, timeoutMs: 100 })).resolves.toMatchObject({ status: "ok", bytes: Buffer.from("ok") });
    expect(blob.list).toHaveBeenCalledWith(expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    expect(blob.get).toHaveBeenCalledWith("traces/r/t/log.txt", expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    blob.get.mockReset().mockResolvedValue(null);
    await expect(new BlobOpsReadAdapter().read({ pathname: "traces/r/t/log.txt", maxBytes: 10, timeoutMs: 100 })).resolves.toMatchObject({ status: "transient" });
    expect(blob.get).toHaveBeenCalledTimes(2);
    blob.list.mockResolvedValue({blobs:[],hasMore:false});blob.get.mockClear();
    await expect(new BlobOpsReadAdapter().read({pathname:"traces/missing",maxBytes:10,timeoutMs:100})).resolves.toEqual({status:"not_found"});
    expect(blob.get).not.toHaveBeenCalled();
  });
  it("applies one deadline to a slow stream, aborts the SDK request, and cancels the reader", async()=>{
    let cancelled=false;blob.list.mockResolvedValue({blobs:[metadata(2)],hasMore:false});
    const stream=new ReadableStream<Uint8Array>({async pull(controller){await new Promise((resolve)=>setTimeout(resolve,30));controller.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;}});
    blob.get.mockResolvedValue({statusCode:200,stream});
    await expect(new BlobOpsReadAdapter().read({pathname:"traces/r/t/log.txt",maxBytes:10,timeoutMs:15})).resolves.toEqual({status:"transient",error:"read_timeout"});
    expect(cancelled).toBe(true);expect(blob.get.mock.calls[0][1].abortSignal.aborted).toBe(true);
  });
});
