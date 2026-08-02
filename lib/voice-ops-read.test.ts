import { describe, expect, it } from "vitest";
import { MemoryVoiceStorage } from "./voice-storage";
describe("voice ops read inventory",()=>it("discovers the manifest and judgments through a bounded read-only page",async()=>{const storage=new MemoryVoiceStorage();await storage.putManifest({version:1,models:[],comparisons:[]} as any);const page=await storage.listOpsRecords("voice/",{limit:10});expect(page.records).toContainEqual({pathname:"voice/manifest.json"});}));
