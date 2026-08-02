import { get, list } from "@vercel/blob";

export interface OpsRecordMetadata { pathname: string; size: number; uploaded_at: string; etag: string }
export interface OpsListPage { records: OpsRecordMetadata[]; cursor?: string; has_more: boolean }
export type OpsReadResult =
  | { status: "ok"; bytes: Buffer; metadata: OpsRecordMetadata }
  | { status: "not_found" }
  | { status: "too_large"; size: number; limit: number }
  | { status: "transient"; error: "read_timeout" | "read_failed" };
export interface OpsReadAdapter {
  listPage(input: { prefix: string; cursor?: string; limit: number }): Promise<OpsListPage>;
  read(input: { pathname: string; maxBytes: number; timeoutMs: number }): Promise<OpsReadResult>;
}

const timeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => Promise.race([
  promise,
  new Promise<T>((_, reject) => setTimeout(() => reject(new Error("read_timeout")), timeoutMs)),
]);
async function boundedBytes(stream: ReadableStream<Uint8Array>, maxBytes: number, timeoutMs: number) {
  const reader=stream.getReader(),chunks:Uint8Array[]=[];let size=0;
  try { while(true){const {done,value}=await timeout(reader.read(),timeoutMs);if(done)break;if(value){size+=value.byteLength;if(size>maxBytes){await reader.cancel();return undefined;}chunks.push(value);}} }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map((chunk)=>Buffer.from(chunk)),size);
}

export class BlobOpsReadAdapter implements OpsReadAdapter {
  async listPage({ prefix, cursor, limit }: { prefix: string; cursor?: string; limit: number }): Promise<OpsListPage> {
    let page: Awaited<ReturnType<typeof list>> | undefined;
    for(let attempt=0;attempt<2;attempt++){try{page=await timeout(list({prefix,cursor,limit}),3_000);break;}catch(error){if(attempt===1)throw error;}}
    if(!page)throw new Error("list_failed");
    return {
      records: page.blobs.map((blob) => ({ pathname: blob.pathname, size: blob.size, uploaded_at: blob.uploadedAt.toISOString(), etag: blob.etag })),
      cursor: page.hasMore ? page.cursor : undefined,
      has_more: page.hasMore,
    };
  }

  async read({ pathname, maxBytes, timeoutMs }: { pathname: string; maxBytes: number; timeoutMs: number }): Promise<OpsReadResult> {
    let metadata: OpsRecordMetadata | undefined;
    try {
      const page = await timeout(this.listPage({ prefix: pathname, limit: 2 }), timeoutMs);
      metadata = page.records.find((record) => record.pathname === pathname);
      if (!metadata) return { status: "not_found" };
      if (metadata.size > maxBytes) return { status: "too_large", size: metadata.size, limit: maxBytes };
    } catch (error) {
      return { status: "transient", error: error instanceof Error && error.message === "read_timeout" ? "read_timeout" : "read_failed" };
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await timeout(get(pathname, { access: "public" }), timeoutMs);
        if (!result) return { status: "not_found" };
        if (result.statusCode !== 200 || !result.stream) throw new Error("read_failed");
        const bytes = await boundedBytes(result.stream, maxBytes, timeoutMs);
        if (!bytes) return { status: "too_large", size: maxBytes + 1, limit: maxBytes };
        return { status: "ok", bytes, metadata };
      } catch (error) {
        if (attempt === 1) return { status: "transient", error: error instanceof Error && error.message === "read_timeout" ? "read_timeout" : "read_failed" };
      }
    }
    return { status: "transient", error: "read_failed" };
  }
}

export function getOpsReadAdapter(): OpsReadAdapter { return new BlobOpsReadAdapter(); }
