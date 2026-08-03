import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("ops read side-effect boundary",()=>it("never imports write, reaper, or dispatch capabilities",()=>{
  const source=["lib/ops-read.ts","lib/ops-read-adapter.ts","app/api/ops/v1/route.ts","app/api/ops/v1/inventory/route.ts","app/api/ops/v1/read/route.ts","app/api/ops/v1/summary/route.ts"].map((path)=>readFileSync(path,"utf8")).join("\n");
  expect(source).not.toMatch(/from ["']\.\/?(?:storage|voice-storage|dispatch|reaper)["']|dispatchQueuedRuns|reapIfStale|\b(?:put|del)\s*\(/);
}));
