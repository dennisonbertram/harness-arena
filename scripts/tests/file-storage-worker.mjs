import { appendRunEventsFile } from "../../lib/file-storage-lock.mjs";

const [root, runId, eventId] = process.argv.slice(2);
if (!root || !runId || !eventId) throw new Error("usage: file-storage-worker <root> <run> <event>");
await appendRunEventsFile(root, runId, [{ ts: new Date().toISOString(), type: "run.created", payload: { submission_id: eventId } }]);
