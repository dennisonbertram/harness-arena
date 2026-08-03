import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("local seed publication", () => {
  it("leaves no partial seed after interruption and a retry publishes exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-arena-seed-publish-"));
    roots.push(root);
    const previousStorage = process.env.STORAGE;
    const previousRoot = process.env.LOCAL_STORAGE_DIR;
    process.env.STORAGE = "file";
    process.env.LOCAL_STORAGE_DIR = root;
    try {
      const seed = await import("./seed-local.mjs");
      const path = join(root, "competitions", "local-development.json");
      await rm(path, { force: true });
      expect(seed.seedLocalCompetition).toBeTypeOf("function");

      await expect(seed.seedLocalCompetition(root, {
        beforePublish: () => { throw new Error("injected seed publication interruption"); },
      })).rejects.toThrow(/injected seed publication interruption/);
      await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      await expect(seed.seedLocalCompetition(root)).resolves.toEqual({ created: true, path });
      await expect(seed.seedLocalCompetition(root)).resolves.toEqual({ created: false, path });
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ id: "local-development", status: "live" });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      if (previousStorage === undefined) delete process.env.STORAGE; else process.env.STORAGE = previousStorage;
      if (previousRoot === undefined) delete process.env.LOCAL_STORAGE_DIR; else process.env.LOCAL_STORAGE_DIR = previousRoot;
    }
  });
});
