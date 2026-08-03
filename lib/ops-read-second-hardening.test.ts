import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createOpsReadService, decodeOpsCursor, encodeOpsCursor, redactOpsValue } from "./ops-read";
import { isRunOperationallyStale } from "./stale-policy";
import type { OpsReadAdapter } from "./ops-read-adapter";

const metadata = (pathname: string, size: number) => ({ pathname, size, uploaded_at: "2026-08-02T00:00:00.000Z", etag: "e" });
describe("second Sol hardening", () => {
  it("decodes gzip traces and mixed archives, redacts secrets, and rejects unknown binary", async () => {
    process.env.OPS_READ_TOKEN = "caller-token"; process.env.OPS_READ_CURSOR_SECRET = "cursor-only"; process.env.BLOB_READ_WRITE_TOKEN = "overlap-secret";
    const compressed = gzipSync("Bearer caller-token https://blob.test/x?sig=signed overlap-secret");
    const adapter = { listPage: vi.fn(), read: vi.fn(async ({ pathname }) => ({ status: "ok" as const, bytes: compressed, metadata: metadata(pathname, compressed.length) })) } as OpsReadAdapter;
    const service = createOpsReadService(adapter);
    const trace = await service.read("traces", { run_id: "r", task_id: "t", name: "session.jsonl" });
    expect(trace).toMatchObject({ item: "Bearer [REDACTED] https://blob.test/x [REDACTED]" });
    const archive = await service.read("cleanup_archives", { path: "c/o/traces/r/t/session.jsonl" });
    expect(archive).toMatchObject({ item: expect.stringContaining("[REDACTED]") });
    adapter.read = vi.fn(async ({ pathname }) => ({ status: "ok" as const, bytes: Buffer.from([0,1,2,3]), metadata: metadata(pathname,4) }));
    await expect(service.read("archives", { path: "unknown.bin" })).resolves.toMatchObject({ error: { code: "unsupported_binary" } });
    const bomb=gzipSync("x".repeat(800_000));adapter.read=vi.fn(async({pathname})=>({status:"ok" as const,bytes:bomb,metadata:metadata(pathname,bomb.length)}));
    await expect(service.read("traces",{run_id:"r",task_id:"t",name:"bomb.gz"})).resolves.toMatchObject({error:{code:"too_large"}});
  });

  it("redacts embedded, multiple, and overlapping secret and bearer values recursively", () => {
    process.env.OPS_ALPHA_SECRET="abc-secret"; process.env.OPS_BETA_TOKEN="secret";
    expect(redactOpsValue({ nested:["x abc-secret y secret z", "Bearer abc-secret"] })).toEqual({ nested:["x [REDACTED] y [REDACTED] z", "Bearer [REDACTED]"] });
  });

  it("requires a server-only cursor key that the caller token cannot forge", () => {
    process.env.OPS_READ_TOKEN="caller"; delete process.env.OPS_READ_CURSOR_SECRET;
    expect(() => encodeOpsCursor({kind:"runs",prefix:"runs/",snapshot_at:"2026-08-02T00:00:00.000Z"})).toThrow("cursor_secret_missing");
    process.env.OPS_READ_CURSOR_SECRET="server-only";
    const cursor=encodeOpsCursor({kind:"runs",prefix:"runs/",snapshot_at:"2026-08-02T00:00:00.000Z"});
    process.env.OPS_READ_CURSOR_SECRET="caller";
    expect(() => decodeOpsCursor(cursor,{kind:"runs",prefix:"runs/"})).toThrow("invalid_cursor");
  });

  it("shares stale semantics for running and dispatched versus waiting queued runs", () => {
    process.env.REAP_STALE_MINUTES="20"; const now=Date.parse("2026-08-02T01:00:00.000Z"), old="2026-08-02T00:00:00.000Z", recent="2026-08-02T00:55:00.000Z";
    expect(isRunOperationallyStale({status:"running",created_at:old},old,now)).toBe(true);
    expect(isRunOperationallyStale({status:"running",created_at:old},recent,now)).toBe(false);
    expect(isRunOperationallyStale({status:"queued",created_at:old},old,now)).toBe(false);
    expect(isRunOperationallyStale({status:"queued",created_at:old,dispatched_at:old},old,now)).toBe(true);
  });

  it("returns an explicit incomplete summary when its overall deadline expires", async () => {
    const adapter={listPage:()=>new Promise<never>(()=>{}),read:vi.fn()} as OpsReadAdapter;
    const result=await createOpsReadService(adapter,{summaryDeadlineMs:20}).summary();
    expect(result.scan).toMatchObject({complete:false,truncated:true,reason:"deadline"});
  });
  it("uses the shared stale policy across paginated runs and recent event metadata", async () => {
    process.env.REAP_STALE_MINUTES="20";const old="2020-01-01T00:00:00.000Z",recent=new Date().toISOString();
    const runs=[{id:"silent",status:"running",created_at:old},{id:"recent",status:"running",created_at:old},{id:"waiting",status:"queued",created_at:old},{id:"claimed",status:"queued",created_at:old,dispatched_at:old}];
    const listPage=vi.fn(async({prefix,cursor})=>prefix==="runs/"?cursor?{records:runs.slice(2).map((r)=>metadata(`runs/${r.id}.json`,20)),has_more:false}:{records:runs.slice(0,2).map((r)=>metadata(`runs/${r.id}.json`,20)),cursor:"runs-2",has_more:true}:prefix==="events/"?{records:[{...metadata("events/recent/0000000001.json",1),uploaded_at:recent}],has_more:false}:{records:[],has_more:false});
    const read=vi.fn(async({pathname})=>{const run=runs.find((candidate)=>pathname===`runs/${candidate.id}.json`);return {status:"ok" as const,bytes:Buffer.from(JSON.stringify(run??{})),metadata:metadata(pathname,20)};});
    const summary=await createOpsReadService({listPage,read} as OpsReadAdapter).summary();
    expect(summary.run_states).toEqual({queued:2,running:2,failed:0,stale:2});
    expect(listPage).toHaveBeenCalledWith(expect.objectContaining({prefix:"runs/",cursor:"runs-2"}));
  });
});
