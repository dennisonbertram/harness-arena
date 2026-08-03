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
      // Listed-object URLs must never become an anonymous read, including
      // short member names (`b.url`) or an alias assigned before fetch().
      expect(source, file).not.toMatch(/fetch\s*\([^)]*\.[ \t]*url\b/);
      const urlAliases = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*\.\s*url\b/g)]
        .map((match) => match[1]);
      for (const alias of urlAliases) {
        expect(source, `${file}: listed-object URL alias ${alias}`).not.toMatch(
          new RegExp(`\\bfetch\\s*\\(\\s*${alias}\\b`),
        );
      }
      for (const match of source.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*[A-Za-z_$][\w$]*/g)) {
        const urlBinding = /(?:^|,)\s*url\s*(?::\s*([A-Za-z_$][\w$]*))?(?:,|$)/.exec(match[1]);
        if (!urlBinding) continue;
        const alias = urlBinding[1] ?? "url";
        expect(source, `${file}: destructured listed-object URL alias ${alias}`).not.toMatch(
          new RegExp(`\\bfetch\\s*\\(\\s*${alias}\\b`),
        );
      }
      expect(source, file).not.toMatch(/method\s*:\s*["']HEAD["']/);
    }
  });
});
