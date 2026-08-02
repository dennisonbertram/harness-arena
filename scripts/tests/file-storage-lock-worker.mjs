import { access, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireDirectoryLock } from "../../lib/file-storage-lock.mjs";

const [lock, ready, gate, events, id, mode = "release"] = process.argv.slice(2);
if (!lock || !ready || !gate || !events || !id) throw new Error("usage: file-storage-lock-worker <lock> <ready> <gate> <events> <id>");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await writeFile(join(ready, id), "ready", { flag: "wx" });
while (true) {
  try { await access(gate); break; } catch { await delay(2); }
}
const crashStage = mode.startsWith("crash:") ? mode.slice("crash:".length) : undefined;
const crash = () => process.kill(process.pid, "SIGKILL");
const release = await acquireDirectoryLock(lock, {
  staleMs: 0,
  timeoutMs: 15_000,
  pollMs: 0,
  ...(crashStage ? { [crashStage]: crash } : {}),
});
try {
  await appendFile(events, `enter ${id}\n`);
  if (mode === "hold") await new Promise(() => { setInterval(() => {}, 1_000); });
  if (mode === "hold-gate") {
    while (true) {
      try { await access(`${gate}.release-${id}`); break; } catch { await delay(2); }
    }
  }
  await delay(20);
  await appendFile(events, `exit ${id}\n`);
} finally {
  await release();
}
