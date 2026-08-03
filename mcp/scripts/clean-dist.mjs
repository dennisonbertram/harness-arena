import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(packageDirectory, "dist");

if (basename(dist) !== "dist" || dirname(dist) !== packageDirectory) {
  throw new Error("refusing to clean an unexpected MCP build path");
}

await rm(dist, { recursive: true, force: true });
