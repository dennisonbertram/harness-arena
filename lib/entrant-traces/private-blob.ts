import { createHash } from "node:crypto";
import type {
  GetBlobResult,
  GetCommandOptions,
  IssueSignedTokenOptions,
  IssuedSignedToken,
  PresignUrlOptions,
  PresignUrlResult,
  PutBlobResult,
  PutCommandOptions,
  put,
} from "@vercel/blob";

const MAX_ARTIFACT_BYTES = 1024 * 1024;
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const PRIVATE_ARTIFACT_KEY = /^private\/artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type BlobAdapter = {
  issueSignedToken(options: IssueSignedTokenOptions): Promise<IssuedSignedToken>;
  presignUrl(token: Pick<IssuedSignedToken, "clientSigningToken" | "delegationToken">, options: PresignUrlOptions & { access: "private" }): Promise<PresignUrlResult>;
  get(pathname: string, options: GetCommandOptions): Promise<GetBlobResult | null>;
  put(pathname: string, body: Parameters<typeof put>[1], options: PutCommandOptions): Promise<PutBlobResult>;
};

type Artifact = {
  object_key: string;
  compression: string;
  state: string;
};

type UploadArtifact = Artifact & { compressed_bytes: number };
type ReadArtifact = { object_key: string; sha256: string; max_bytes: number };
type ServerPutArtifact = Artifact & { bytes: Buffer; max_bytes: number };
type FailureCode = "invalid_artifact" | "invalid_state" | "not_found" | "too_large" | "checksum_mismatch" | "storage_error";
type Failure = { ok: false; error: { code: FailureCode } };

const fail = (code: FailureCode): Failure => ({ ok: false, error: { code } });

function validKey(value: unknown): value is string {
  return typeof value === "string" && PRIVATE_ARTIFACT_KEY.test(value);
}

function validSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_ARTIFACT_BYTES;
}

function validArtifact(value: Artifact): boolean {
  return validKey(value.object_key) && (value.compression === "gzip" || value.compression === "none");
}

function contentType(compression: string): "application/gzip" | "application/json" {
  return compression === "gzip" ? "application/gzip" : "application/json";
}

function nowInMs(now: () => number | Date): number {
  const value = now();
  return typeof value === "number" ? value : value.getTime();
}

function asBytes(chunk: Uint8Array): Uint8Array {
  return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
}

/**
 * Creates the deliberately small boundary between entrant artifacts and Vercel Blob.
 * Callers receive only a short-lived URL; Blob credentials never leave this adapter.
 */
export function createPrivateArtifactBlob(blob: BlobAdapter, options: {
  privateWriteToken: string;
  privateReadToken: string;
  now: () => number | Date;
}) {
  return {
    async prepareUpload(input: UploadArtifact): Promise<{ upload_url: string; expires_at: number } | Failure> {
      if (!validArtifact(input) || !validSize(input.compressed_bytes)) return fail("invalid_artifact");
      if (input.state !== "pending_upload") return fail("invalid_state");

      const expiresAt = nowInMs(options.now) + UPLOAD_TTL_MS;
      const uploadContentType = contentType(input.compression);
      try {
        const signedToken = await blob.issueSignedToken({
          pathname: input.object_key,
          operations: ["put"],
          validUntil: expiresAt,
          maximumSizeInBytes: input.compressed_bytes,
          allowedContentTypes: [uploadContentType],
          token: options.privateWriteToken,
        });
        const { presignedUrl } = await blob.presignUrl(signedToken, {
          operation: "put",
          pathname: input.object_key,
          access: "private",
          validUntil: expiresAt,
          maximumSizeInBytes: input.compressed_bytes,
          allowedContentTypes: [uploadContentType],
          allowOverwrite: false,
          addRandomSuffix: false,
        });
        return { upload_url: presignedUrl, expires_at: expiresAt };
      } catch {
        return fail("storage_error");
      }
    },

    async readVerified(input: ReadArtifact): Promise<{ ok: true; bytes: Buffer } | Failure> {
      if (!validKey(input.object_key) || typeof input.sha256 !== "string" || !SHA256.test(input.sha256) || !validSize(input.max_bytes)) {
        return fail("invalid_artifact");
      }

      const controller = new AbortController();
      let result: GetBlobResult | null;
      try {
        result = await blob.get(input.object_key, {
          access: "private",
          token: options.privateReadToken,
          useCache: false,
          abortSignal: controller.signal,
        });
      } catch {
        return fail("storage_error");
      }
      if (!result || result.statusCode !== 200 || !result.stream) return fail("not_found");

      const reader = result.stream.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(asBytes(value));
          total += chunk.byteLength;
          if (total > input.max_bytes) {
            controller.abort();
            await reader.cancel();
            return fail("too_large");
          }
          chunks.push(chunk);
        }
      } catch {
        return fail("storage_error");
      } finally {
        reader.releaseLock?.();
      }

      const bytes = Buffer.concat(chunks, total);
      if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) return fail("checksum_mismatch");
      return { ok: true, bytes };
    },

    async serverPut(input: ServerPutArtifact): Promise<{ ok: true } | Failure> {
      if (!validArtifact(input) || !validSize(input.max_bytes) || input.state !== "pending_upload") {
        return input.state !== "pending_upload" ? fail("invalid_state") : fail("invalid_artifact");
      }
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > input.max_bytes) return fail("too_large");

      try {
        await blob.put(input.object_key, input.bytes, {
          access: "private",
          token: options.privateWriteToken,
          contentType: contentType(input.compression),
          maximumSizeInBytes: input.max_bytes,
          allowOverwrite: false,
          addRandomSuffix: false,
        });
        return { ok: true };
      } catch {
        return fail("storage_error");
      }
    },
  };
}
