import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicCreateFile } from "../lib/file-storage-lock.mjs";

const competition = {
  id: "local-development", arena: "harness-arena", harness: "pi", model: "local", prize_amount_usd: null,
  prize_cadence: null, status: "live", auto_baseline: false, created_at: "2026-08-02T00:00:00.000Z",
};

export async function seedLocalCompetition(storageRoot, { beforePublish } = {}) {
  const root = resolve(storageRoot);
  const path = join(root, "competitions", "local-development.json");
  try {
    await atomicCreateFile(path, JSON.stringify(competition), 0o600, root, { beforePublish });
    return { created: true, path };
  } catch (error) {
    if (error?.code === "EEXIST") return { created: false, path };
    throw error;
  }
}

async function main() {
  const root = process.env.LOCAL_STORAGE_DIR;
  if (!root || process.env.STORAGE !== "file") throw new Error("seed-local requires STORAGE=file and LOCAL_STORAGE_DIR");
  await seedLocalCompetition(root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
