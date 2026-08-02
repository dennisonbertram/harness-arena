import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeStoragePath } from "../lib/file-storage-lock.mjs";

const root = process.env.LOCAL_STORAGE_DIR;
if (!root || process.env.STORAGE !== "file") throw new Error("seed-local requires STORAGE=file and LOCAL_STORAGE_DIR");
const competition = {
  id: "local-development", arena: "harness-arena", harness: "pi", model: "local", prize_amount_usd: null,
  prize_cadence: null, status: "live", auto_baseline: false, created_at: "2026-08-02T00:00:00.000Z",
};
const path = join(root, "competitions", "local-development.json");
await assertSafeStoragePath(root, path);
await mkdir(join(root, "competitions"), { recursive: true });
await assertSafeStoragePath(root, path);
try { await writeFile(path, JSON.stringify(competition), { flag: "wx", mode: 0o600 }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
