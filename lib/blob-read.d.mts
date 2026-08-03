export const MAX_BLOB_JSON_BYTES: number;
export function readBoundedBytes(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer>;
export function readBlobJson<T = unknown>(identifier: string, options?: {
  maxBytes?: number;
  required?: boolean;
  token?: string;
  abortSignal?: AbortSignal;
  useCache?: boolean;
}): Promise<T | undefined>;
