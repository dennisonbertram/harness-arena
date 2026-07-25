import { readFileSync } from "node:fs";
import path from "node:path";

/** pi's built-in default system prompt, served by GET /api/baseline-prompt and used as the competition's baseline text. */
export function readVanillaPrompt(): string {
  return readFileSync(path.join(process.cwd(), "docs", "pi-vanilla-system-prompt.txt"), "utf8");
}
