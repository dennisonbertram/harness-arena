import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Blob call-site inventory", () => {
  it("derives every SDK caller and forbids public literals or direct object URL delivery", () => {
    const files = execFileSync("rg", ["-l", "@vercel/blob", "app", "lib", "scripts", "--glob", "!*.test.*"], { encoding: "utf8" }).trim().split("\n");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/access\s*:\s*["']public["']/);
      expect(source, file).not.toMatch(/fetch\s*\(\s*(?:blob\.)?url/);
      expect(source, file).not.toMatch(/method\s*:\s*["']HEAD["']/);
    }
  });
});
