import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createOpsReadService, decodeOpsCursor, encodeOpsCursor, redactOpsValue } from "./ops-read";
import { redactOpsText } from "./ops-redaction.mjs";
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

  it("keeps safe multiline runner-log records readable while redacting embedded JSON and isolating malformed records", async () => {
    const previousTraceSecret = process.env.OPS_TRACE_SECRET;
    process.env.OPS_TRACE_SECRET = "trace-secret";
    try {
      const runnerLog = [
        "[2026-08-04T00:00:00.000Z] runner started component=runner",
        "[2026-08-04T00:00:01.000Z] setup diagnostic {\"operation\":\"container_create\",\"stderr\":\"trace-secret\",\"timedOut\":false}",
        "[2026-08-04T00:00:02.000Z] {\"api_key\":\"key-secret\"} {\"access_token\":\"token-secret\"} ordinary text Bearer bearer-secret https://signed.test/path?sig=signed",
        "[2026-08-04T00:00:03.000Z] malformed setup {\"client_secret\":\"hostile-secret\"",
        "[2026-08-04T00:00:04.000Z] runner completed status=ok",
      ].join("\n");
      const adapter = {
        listPage: vi.fn(),
        read: vi.fn(async ({ pathname }) => ({
          status: "ok" as const,
          bytes: Buffer.from(runnerLog),
          metadata: metadata(pathname, Buffer.byteLength(runnerLog)),
        })),
      } as OpsReadAdapter;

      const result = await createOpsReadService(adapter).read("traces", {
        run_id: "r",
        task_id: "_run",
        name: "runner-log.txt",
      });
      expect(result).toMatchObject({ item: expect.stringContaining("runner started component=runner") });
      const output = String((result as { item: unknown }).item);
      expect(output).toContain("container_create");
      expect(output).toContain("runner completed status=ok");
      expect(output).toContain("[REDACTED]");
      for (const secret of ["trace-secret", "key-secret", "token-secret", "bearer-secret", "hostile-secret", "sig=signed"]) {
        expect(output).not.toContain(secret);
      }
    } finally {
      if (previousTraceSecret === undefined) delete process.env.OPS_TRACE_SECRET;
      else process.env.OPS_TRACE_SECRET = previousTraceSecret;
    }
  });

  it("fails closed for bracketed prefixes that are not strict runner timestamps", () => {
    expect(redactOpsText("[operator note] opaque runner payload")).toBe("[REDACTED]");
    expect(redactOpsText("[2026-13-04T00:00:00.000Z] opaque runner payload")).toBe("[REDACTED]");
    expect(redactOpsText("[2026-08-04T00:00:00.000Z] runner started component=runner")).toContain("runner started");
  });

  it("uses one redaction traversal budget across every runner-log record", () => {
    const object = JSON.stringify(Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`field_${index}`, index])));
    const runnerLog = `[2026-08-04T00:00:00.000Z] ${object}\n[2026-08-04T00:00:01.000Z] ${object}`;
    expect(redactOpsText(runnerLog)).toBe("[REDACTED]");
  });

  it("parses and redacts encoded configured secrets in later JSON-array records", () => {
    const output = redactOpsText([
      "runner started component=runner",
      "[\"configured\\u002dsecret\"]",
      "runner completed status=ok",
    ].join("\n"), ["configured-secret"]);
    expect(output).toBe([
      "runner started component=runner",
      "[\"[REDACTED]\"]",
      "runner completed status=ok",
    ].join("\n"));
  });

  it("parses embedded JSON arrays after a strict runner timestamp without confusing the timestamp brackets", () => {
    expect(redactOpsText(
      '[2026-08-04T00:00:00.000Z] diagnostic ["configured\\u002dsecret"]',
      ["configured-secret"],
    )).toBe('[2026-08-04T00:00:00.000Z] diagnostic ["[REDACTED]"]');
  });

  it("fails closed for later arbitrary bracket records but preserves the exact truncation marker and neighbors", () => {
    const output = redactOpsText([
      "runner started component=runner",
      "[operator note] opaque runner payload",
      "[TRUNCATED]",
      "runner completed status=ok",
    ].join("\n"));
    expect(output).toBe([
      "runner started component=runner",
      "[REDACTED]",
      "[TRUNCATED]",
      "runner completed status=ok",
    ].join("\n"));
  });

  it("shares the assignment budget across recursive strings and sibling values", () => {
    const assignments = Array.from({ length: 256 }, (_, index) => `field_${index}=value_${index}`).join(" ");
    expect(redactOpsValue({ embedded: assignments, trailing: "api_key=last-secret" })).toBe("[REDACTED]");
  });

  it("bounds properties parsed from text at 256 without lowering the structured object traversal cap", () => {
    const structured = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`safe_${index}`, "ok"]));
    expect(redactOpsValue(JSON.stringify(structured))).toBe("[REDACTED]");
    expect(redactOpsValue(structured)).toEqual(structured);
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
