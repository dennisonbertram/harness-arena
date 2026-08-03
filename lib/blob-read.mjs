import { get } from "@vercel/blob";
import { blobCommandOptions } from "./blob-access.mjs";

export const MAX_BLOB_JSON_BYTES = 1024 * 1024;

export async function readBoundedBytes(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel("size limit");
        const error = new Error(`payload too large: exceeds ${limit} byte limit`);
        error.name = "PayloadTooLargeError";
        throw error;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((value) => Buffer.from(value)), size);
  } finally {
    reader.releaseLock();
  }
}

export async function readBlobJson(identifier, {
  maxBytes = MAX_BLOB_JSON_BYTES,
  required = false,
  ...commandOptions
} = {}) {
  const result = await get(identifier, blobCommandOptions(commandOptions));
  if (!result || (result.statusCode !== undefined && result.statusCode !== 200) || !result.stream) {
    if (required) throw new Error(`blob get ${result?.statusCode ?? 404}`);
    return undefined;
  }
  return JSON.parse((await readBoundedBytes(result.stream, maxBytes)).toString("utf8"));
}
