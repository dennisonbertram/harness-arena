import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./storage";

describe("read-only ops storage", () => {
  it("lists bounded raw records and reports missing/corrupt event holes explicitly", async () => {
    const storage = new MemoryStorage();
    await storage.putTraceBlob("run-a", "task-a", "runner-log.txt", "trace");
    const page = await storage.listOpsRecords("traces/", { limit: 1 });
    expect(page.records).toEqual([{ pathname: "traces/run-a/task-a/runner-log.txt" }]);
    expect(page.partial).toEqual([]);
    await expect(storage.readOpsRecord("events/run-a/0000000001.json")).resolves.toEqual({ found: false });
  });
});
