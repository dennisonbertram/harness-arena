import { describe, expect, it, vi } from "vitest";
import { createOpsReadService } from "./ops-read";
const storage = vi.hoisted(() => ({ listOpsRecords: vi.fn().mockResolvedValue({records:[],partial:["traces/r/t/bad"]}), listRuns: vi.fn(), listSubmissions: vi.fn(), listCompetitions: vi.fn(), putRun: vi.fn(), appendRunEvents: vi.fn() }));
vi.mock("./storage", () => ({ getStorage: () => storage, PartialReadError: class PartialReadError extends Error { constructor(readonly prefix:string,readonly missing:number,readonly total:number){super();} } }));
vi.mock("./voice-storage", () => ({ getVoiceStorage: () => ({ getManifest: vi.fn().mockResolvedValue({version:1}), listAllJudgments: vi.fn().mockResolvedValue({judgments:[{comparison_id:"c"}],unreadable:1}) }) }));
describe("ops read partial fixtures",()=>it("reports raw corruption explicitly without writes",async()=>{const out=await createOpsReadService().list("traces",{limit:10});expect(out).toMatchObject({error:{code:"partial_read"}});expect(storage.putRun).not.toHaveBeenCalled();expect(storage.appendRunEvents).not.toHaveBeenCalled();}));
