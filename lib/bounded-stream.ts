export async function readBoundedStream(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; if (!value) continue; size += value.byteLength; if (size > limit) { await reader.cancel("size limit"); throw new Error("payload too large"); } chunks.push(value); }
    return Buffer.concat(chunks.map((value) => Buffer.from(value)), size);
  } finally { reader.releaseLock(); }
}
