import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = ["app", "lib", "scripts"] as const;
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".next", ".git"]);

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function findBlobSdkCallers(workspace = process.cwd()): string[] {
  const root = realpathSync(workspace);
  const matches: string[] = [];

  function visit(directory: string): void {
    const canonicalDirectory = realpathSync(directory);
    if (!isWithin(root, canonicalDirectory)) throw new Error(`inventory path escaped workspace: ${directory}`);
    for (const entry of readdirSync(canonicalDirectory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (entry.isSymbolicLink()) continue;
      const absolute = resolve(canonicalDirectory, entry.name);
      if (!isWithin(root, absolute)) throw new Error(`inventory entry escaped workspace: ${absolute}`);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) visit(absolute);
        continue;
      }
      if (!entry.isFile() || entry.name.includes(".test.")) continue;
      if (readFileSync(absolute, "utf8").includes("@vercel/blob")) {
        matches.push(relative(root, absolute).split(sep).join("/"));
      }
    }
  }

  for (const sourceRoot of SOURCE_ROOTS) visit(resolve(root, sourceRoot));
  return matches.sort();
}

describe("Blob call-site inventory", () => {
  it("derives the same inventory when PATH has no rg or other executable", () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/path/without/executables";
    try {
      const files = findBlobSdkCallers();
      expect(files.length).toBeGreaterThan(0);
      expect(files).toEqual([...files].sort());
      expect(files.every((file) => !file.includes(".test.") && !file.startsWith("../"))).toBe(true);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("skips excluded directories and exact test-file patterns", () => {
    const workspace = mkdtempSync(join(tmpdir(), "blob-inventory-"));
    try {
      for (const sourceRoot of SOURCE_ROOTS) mkdirSync(join(workspace, sourceRoot), { recursive: true });
      writeFileSync(join(workspace, "lib", "caller.ts"), 'import "@vercel/blob";');
      writeFileSync(join(workspace, "lib", "contest.ts"), 'import "@vercel/blob";');
      writeFileSync(join(workspace, "lib", "caller.test.ts"), 'import "@vercel/blob";');
      for (const excluded of EXCLUDED_DIRECTORIES) {
        mkdirSync(join(workspace, "lib", excluded), { recursive: true });
        writeFileSync(join(workspace, "lib", excluded, "hidden.ts"), 'import "@vercel/blob";');
      }
      expect(findBlobSdkCallers(workspace)).toEqual(["lib/caller.ts", "lib/contest.ts"]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    ["in-root directory before directory exclusions", "directory", "workspace", "node_modules"],
    ["escaping directory", "directory", "external", "linked-directory"],
    ["in-root file before test-file exclusions", "file", "workspace", "caller.test.ts"],
    ["escaping file", "file", "external", "linked.ts"],
  ] as const)("fails closed on an %s symlink without exposing its target", (_case, kind, scope, linkName) => {
    const workspace = mkdtempSync(join(tmpdir(), "blob-inventory-symlink-"));
    const external = mkdtempSync(join(tmpdir(), "blob-inventory-target-secret-"));
    try {
      for (const sourceRoot of SOURCE_ROOTS) mkdirSync(join(workspace, sourceRoot), { recursive: true });
      const targetRoot = scope === "workspace" ? join(workspace, "target-secret") : join(external, "target-secret");
      if (kind === "directory") {
        mkdirSync(targetRoot, { recursive: true });
        writeFileSync(join(targetRoot, "caller.ts"), 'import "@vercel/blob";');
      } else {
        mkdirSync(resolve(targetRoot, ".."), { recursive: true });
        writeFileSync(targetRoot, 'import "@vercel/blob";');
      }
      symlinkSync(targetRoot, join(workspace, "lib", linkName));

      expect(() => findBlobSdkCallers(workspace)).toThrowError(
        new Error(`Blob inventory refuses symlink: lib/${linkName}`),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("derives every SDK caller and forbids public literals or direct object URL delivery", () => {
    const files = findBlobSdkCallers();
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
