import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({ listPage: vi.fn(), read: vi.fn().mockResolvedValue({status:"ok",bytes:Buffer.from("secret trace"),metadata:{pathname:"traces/r1/t1/runner-log.txt",size:12,uploaded_at:"2026-01-01T00:00:00.000Z",etag:"e"}}), putRun: vi.fn(), appendRunEvents: vi.fn() }));
vi.mock("@/lib/ops-read-adapter", () => ({ getOpsReadAdapter: () => storage }));
import { GET } from "./route";
describe("GET ops read", () => it("reads trace bytes without signed URLs or writes", async () => { process.env.OPS_READ_TOKEN="read-token"; const r=await GET(new NextRequest("http://localhost/api/ops/v1/read?kind=traces&run_id=r1&task_id=t1&name=runner-log.txt",{headers:{authorization:"Bearer read-token"}})); expect(r.status).toBe(200); expect(await r.json()).toMatchObject({schema_version:"ops.v1",item:"secret trace",metadata:{size:12,etag:"e"}}); expect(storage.putRun).not.toHaveBeenCalled(); expect(storage.appendRunEvents).not.toHaveBeenCalled(); }));
