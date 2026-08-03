import { describe, expect, it, vi } from "vitest";
import { createPrivateArtifactBlob } from "./private-blob";

const KEY = "private/artifacts/00000000-0000-0000-0000-000000000400";
const SHA = "a".repeat(64);

function service() {
  const signedToken = {
    clientSigningToken: "never-return-client-signing-token",
    delegationToken: "never-return-delegation-token",
    validUntil: 600_000,
  };
  const issueSignedToken = vi.fn().mockResolvedValue(signedToken);
  const presignUrl = vi.fn().mockResolvedValue({ presignedUrl: "https://upload.example/private" });
  const get = vi.fn();
  const put = vi.fn();
  return { issueSignedToken, presignUrl, get, put, signedToken };
}

describe("private entrant artifact blob boundary", () => {
  it.each([
    [{ object_key: "public/escape", compression: "gzip", compressed_bytes: 128, state: "pending_upload" }],
    [{ object_key: "private/artifacts/../../escape", compression: "gzip", compressed_bytes: 128, state: "pending_upload" }],
    [{ object_key: KEY, compression: "brotli", compressed_bytes: 128, state: "pending_upload" }],
    [{ object_key: KEY, compression: "gzip", compressed_bytes: 1_048_577, state: "pending_upload" }],
  ])("rejects unsafe keys, encodings, and sizes before issuing credentials", async (input) => {
    const blob = service();
    const api = createPrivateArtifactBlob(blob, { privateWriteToken: "write", privateReadToken: "read", now: () => 0 });

    await expect(api.prepareUpload(input)).resolves.toEqual({ ok: false, error: { code: "invalid_artifact" } });
    expect(blob.issueSignedToken).not.toHaveBeenCalled();
    expect(blob.presignUrl).not.toHaveBeenCalled();
  });

  it("prepares one private gzip PUT for the exact server artifact key without exposing signing credentials", async () => {
    const blob = service();
    const api = createPrivateArtifactBlob(blob, { privateWriteToken: "write", privateReadToken: "read", now: () => 0 });
    const result = await api.prepareUpload({ object_key: KEY, compression: "gzip", compressed_bytes: 128, state: "pending_upload" });
    expect(blob.issueSignedToken).toHaveBeenCalledWith({
      pathname: KEY,
      operations: ["put"],
      validUntil: 600_000,
      maximumSizeInBytes: 128,
      allowedContentTypes: ["application/gzip"],
      token: "write",
    });
    expect(blob.presignUrl).toHaveBeenCalledWith(blob.signedToken, {
      operation: "put",
      pathname: KEY,
      access: "private",
      validUntil: 600_000,
      maximumSizeInBytes: 128,
      allowedContentTypes: ["application/gzip"],
      allowOverwrite: false,
      addRandomSuffix: false,
    });
    expect(result).toEqual({ upload_url: "https://upload.example/private", expires_at: 600_000 });
    expect(JSON.stringify(result)).not.toMatch(/token|delegation|signing/i);
  });

  it("supports an uncompressed JSON artifact without weakening the same private upload constraints", async () => {
    const blob = service();
    const api = createPrivateArtifactBlob(blob, { privateWriteToken: "write", privateReadToken: "read", now: () => 0 });

    await expect(api.prepareUpload({ object_key: KEY, compression: "none", compressed_bytes: 64, state: "pending_upload" }))
      .resolves.toEqual({ upload_url: "https://upload.example/private", expires_at: 600_000 });
    expect(blob.issueSignedToken).toHaveBeenCalledWith(expect.objectContaining({
      allowedContentTypes: ["application/json"],
      maximumSizeInBytes: 64,
    }));
    expect(blob.presignUrl).toHaveBeenCalledWith(blob.signedToken, expect.objectContaining({
      access: "private",
      allowedContentTypes: ["application/json"],
      allowOverwrite: false,
      addRandomSuffix: false,
    }));

    await expect(api.serverPut({ object_key: KEY, bytes: Buffer.from("{}"), compression: "none", max_bytes: 64, state: "pending_upload" }))
      .resolves.toEqual({ ok: true });
    expect(blob.put).toHaveBeenCalledWith(KEY, expect.anything(), expect.objectContaining({ contentType: "application/json" }));
  });

  it("reads private blobs by pathname with the separate read token, bounded abortable streaming, and checksum/not-found handling", async () => {
    const blob = service();
    const abort = vi.fn();
    blob.get.mockResolvedValue({
      statusCode: 200,
      stream: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: Buffer.from("abc") })
            .mockResolvedValueOnce({ done: true }),
          cancel: abort,
        }),
      },
    });
    const api = createPrivateArtifactBlob(blob, { privateWriteToken: "write", privateReadToken: "read", now: () => 0 });
    await expect(api.readVerified({ object_key: KEY, sha256: SHA, max_bytes: 2 })).resolves.toEqual({ ok: false, error: { code: "too_large" } });
    expect(blob.get).toHaveBeenCalledWith(KEY, expect.objectContaining({ access: "private", token: "read", useCache: false, abortSignal: expect.any(AbortSignal) }));
    expect(abort).toHaveBeenCalled();

    blob.get.mockResolvedValueOnce({
      statusCode: 200,
      stream: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("abc")); controller.close(); } }),
    });
    await expect(api.readVerified({ object_key: KEY, sha256: SHA, max_bytes: 128 })).resolves.toEqual({ ok: false, error: { code: "checksum_mismatch" } });

    blob.get.mockResolvedValueOnce(null);
    await expect(api.readVerified({ object_key: KEY, sha256: SHA, max_bytes: 128 })).resolves.toEqual({ ok: false, error: { code: "not_found" } });
  });

  it("uses a bounded private server-put fallback and cannot reuse a fixed finalized pathname", async () => {
    const blob = service();
    const api = createPrivateArtifactBlob(blob, { privateWriteToken: "write", privateReadToken: "read", now: () => 0 });
    await expect(api.serverPut({ object_key: KEY, bytes: Buffer.from("gzip"), compression: "gzip", max_bytes: 128, state: "pending_upload" })).resolves.toEqual({ ok: true });
    expect(blob.put).toHaveBeenCalledWith(KEY, expect.anything(), expect.objectContaining({
      access: "private",
      token: "write",
      contentType: "application/gzip",
      maximumSizeInBytes: 128,
      allowOverwrite: false,
      addRandomSuffix: false,
    }));
    await expect(api.prepareUpload({ object_key: KEY, compression: "gzip", compressed_bytes: 128, state: "verified" })).resolves.toEqual({ ok: false, error: { code: "invalid_state" } });
  });

  it("fails closed when private Blob signing, reads, streams, or writes fail", async () => {
    const blob = service();
    const api = createPrivateArtifactBlob(blob, { privateWriteToken: "write", privateReadToken: "read", now: () => 0 });

    blob.issueSignedToken.mockRejectedValueOnce(new Error("signer unavailable"));
    await expect(api.prepareUpload({ object_key: KEY, compression: "gzip", compressed_bytes: 128, state: "pending_upload" }))
      .resolves.toEqual({ ok: false, error: { code: "storage_error" } });

    blob.get.mockRejectedValueOnce(new Error("private read unavailable"));
    await expect(api.readVerified({ object_key: KEY, sha256: SHA, max_bytes: 128 }))
      .resolves.toEqual({ ok: false, error: { code: "storage_error" } });

    blob.get.mockResolvedValueOnce({
      statusCode: 200,
      stream: {
        getReader: () => ({
          read: vi.fn().mockRejectedValue(new Error("stream interrupted")),
          releaseLock: vi.fn(),
        }),
      },
    });
    await expect(api.readVerified({ object_key: KEY, sha256: SHA, max_bytes: 128 }))
      .resolves.toEqual({ ok: false, error: { code: "storage_error" } });

    blob.put.mockRejectedValueOnce(new Error("private write unavailable"));
    await expect(api.serverPut({ object_key: KEY, bytes: Buffer.from("gzip"), compression: "gzip", max_bytes: 128, state: "pending_upload" }))
      .resolves.toEqual({ ok: false, error: { code: "storage_error" } });
  });
});
