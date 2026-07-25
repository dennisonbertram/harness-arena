import { readFileSync } from "node:fs";
import path from "node:path";

// The "vanilla baseline" system prompt the arena publishes as the starting
// point to beat (also served at /api/baseline-prompt). Server-only (reads from
// disk); the file ships with the deployment under docs/.
export function getBaselinePrompt(): string {
  return readFileSync(path.join(process.cwd(), "docs", "pi-vanilla-system-prompt.txt"), "utf8");
}
