import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({ getRun: vi.fn().mockResolvedValue({ id: "r1", task_results: [] }), getSubmission: vi.fn(), getCompetition: vi.fn(), readOpsRecord: vi.fn().mockResolvedValue({found:true,value:"secret trace"}), putRun: vi.fn(), appendRunEvents: vi.fn() }));
vi.mock("@/lib/storage", () => ({ getStorage: () => storage }));
import { GET } from "./route";
describe("GET ops read", () => it("reads trace bytes without signed URLs or writes", async () => { process.env.OPS_READ_TOKEN="read-token"; const r=await GET(new NextRequest("http://localhost/api/ops/v1/read?kind=traces&run_id=r1&task_id=t1&name=runner-log.txt",{headers:{authorization:"Bearer read-token"}})); expect(r.status).toBe(200); expect(await r.json()).toMatchObject({schema_version:"ops.v1",content:"secret trace"}); expect(storage.putRun).not.toHaveBeenCalled(); expect(storage.appendRunEvents).not.toHaveBeenCalled(); }));
