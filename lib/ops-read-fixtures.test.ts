import { describe, expect, it, vi } from "vitest";
import { createOpsReadService } from "./ops-read";
const storage = vi.hoisted(() => ({ listPage: vi.fn().mockRejectedValue(new Error("transient")), read: vi.fn(), putRun: vi.fn(), appendRunEvents: vi.fn() }));
vi.mock("./ops-read-adapter", () => ({ getOpsReadAdapter: () => storage }));
describe("ops read partial fixtures",()=>it("reports raw corruption explicitly without writes",async()=>{const out=await createOpsReadService().list("traces",{limit:10});expect(out).toMatchObject({error:{code:"partial_read"}});expect(storage.putRun).not.toHaveBeenCalled();expect(storage.appendRunEvents).not.toHaveBeenCalled();}));
