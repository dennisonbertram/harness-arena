import { appendRunEventsFile } from "../../lib/file-storage-lock.mjs";

const [root, runId, eventId] = process.argv.slice(2);
if (!root || !runId || !eventId) throw new Error("usage: file-storage-worker <root> <run> <event>");
const holdMs = Number(process.env.HARNESS_FILE_STORAGE_LOCK_HOLD_MS ?? 0);
const timeoutMs = Number(process.env.HARNESS_FILE_STORAGE_LOCK_TIMEOUT_MS ?? 15_000);
await appendRunEventsFile(root, runId, [{ ts: new Date().toISOString(), type: "run.created", payload: { submission_id: eventId } }], {
  lock: {
    timeoutMs,
    afterFencePublished: async () => {
      process.stdout.write("lock-acquired\n");
      if (holdMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, holdMs));
    },
  },
});
