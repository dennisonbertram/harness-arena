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
  it("includes persisted event paths without invoking a dispatcher or write path", async () => {
    const storage = new MemoryStorage();
    await storage.appendRunEvents("run-a", [{ ts: "2026-01-01T00:00:00.000Z", type: "run.created", payload: {} }]);
    await expect(storage.listOpsRecords("events/", { limit: 10 })).resolves.toMatchObject({ records: [{ pathname: "events/run-a/0000000001.json" }] });
  });
  it("reports a hole between persisted event sequence numbers", async () => {
    const storage = new MemoryStorage();
    (storage as any).events.set("run-hole", [{ run_id: "run-hole", seq: 1, ts: "2026-01-01T00:00:00.000Z", type: "run.created", payload: {} }, { run_id: "run-hole", seq: 3, ts: "2026-01-01T00:00:02.000Z", type: "run.completed", payload: {} }]);
    await expect(storage.listOpsRecords("events/run-hole/", { limit: 10 })).resolves.toMatchObject({ partial: ["events/run-hole/0000000002.json"] });
  });
});
