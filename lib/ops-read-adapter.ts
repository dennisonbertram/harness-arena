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

const timeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error("read_timeout")),timeoutMs);
  promise.then((value)=>{clearTimeout(timer);resolve(value);},(error)=>{clearTimeout(timer);reject(error);});
});
async function boundedBytes(stream: ReadableStream<Uint8Array>, maxBytes: number, deadlineAt: number, controller: AbortController) {
  const reader=stream.getReader(),chunks:Uint8Array[]=[];let size=0;
  try { while(true){const remaining=deadlineAt-Date.now();if(remaining<=0)throw new Error("read_timeout");const {done,value}=await timeout(reader.read(),remaining);if(done)break;if(value){size+=value.byteLength;if(size>maxBytes){await reader.cancel();return undefined;}chunks.push(value);}} }
  catch(error){controller.abort();await reader.cancel().catch(()=>{});throw error;}
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map((chunk)=>Buffer.from(chunk)),size);
}

export class BlobOpsReadAdapter implements OpsReadAdapter {
  async listPage({ prefix, cursor, limit }: { prefix: string; cursor?: string; limit: number }): Promise<OpsListPage> {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3_000);
    let page: Awaited<ReturnType<typeof list>> | undefined;
    try {for(let attempt=0;attempt<2;attempt++){try{page=await timeout(list({prefix,cursor,limit,abortSignal:controller.signal}),3_000);break;}catch(error){if(attempt===1)throw error;}}if(!page)throw new Error("list_failed");return {records:page.blobs.map((blob)=>({pathname:blob.pathname,size:blob.size,uploaded_at:blob.uploadedAt.toISOString(),etag:blob.etag})),cursor:page.hasMore?page.cursor:undefined,has_more:page.hasMore};}
    finally{clearTimeout(timer);}
  }

  async read({ pathname, maxBytes, timeoutMs }: { pathname: string; maxBytes: number; timeoutMs: number }): Promise<OpsReadResult> {
    const controller=new AbortController(),deadlineAt=Date.now()+timeoutMs,timer=setTimeout(()=>controller.abort(),timeoutMs);
    let metadata: OpsRecordMetadata | undefined;
    try {
      let page:Awaited<ReturnType<typeof list>>|undefined;
      for(let attempt=0;attempt<2;attempt++){try{page=await timeout(list({prefix:pathname,limit:2,abortSignal:controller.signal}),Math.max(1,deadlineAt-Date.now()));break;}catch(error){if(attempt===1)throw error;}}
      metadata = page?.blobs.filter((record)=>record.pathname===pathname).map((record)=>({pathname:record.pathname,size:record.size,uploaded_at:record.uploadedAt.toISOString(),etag:record.etag}))[0];
      if (!metadata) {clearTimeout(timer);return { status: "not_found" };}
      if (metadata.size > maxBytes) {clearTimeout(timer);return { status: "too_large", size: metadata.size, limit: maxBytes };}
    } catch (error) {
      clearTimeout(timer);return { status: "transient", error: controller.signal.aborted||error instanceof Error&&error.message === "read_timeout" ? "read_timeout" : "read_failed" };
    }
    try { for (let attempt = 0; attempt < 2; attempt++) {
      try { const result = await timeout(get(pathname,{access:"public",abortSignal:controller.signal}),Math.max(1,deadlineAt-Date.now()));
        if (!result) { if(attempt===1)return {status:"transient",error:"read_failed"}; continue; }
        if (result.statusCode !== 200 || !result.stream) throw new Error("read_failed");
        const bytes = await boundedBytes(result.stream, maxBytes, deadlineAt, controller);
        if (!bytes) return { status: "too_large", size: maxBytes + 1, limit: maxBytes };
        return { status: "ok", bytes, metadata };
      } catch (error) {
        if (attempt === 1) return { status: "transient", error: controller.signal.aborted||error instanceof Error&&error.message === "read_timeout" ? "read_timeout" : "read_failed" };
      }
    }
    return { status: "transient", error: "read_failed" };} finally {clearTimeout(timer);}
  }
}

export function getOpsReadAdapter(): OpsReadAdapter { return new BlobOpsReadAdapter(); }
