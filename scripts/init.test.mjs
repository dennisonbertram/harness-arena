import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { choosePort, localEnv, validateStartup } from "./init-lib.mjs";

const dirs = [];
async function worktree() {
  const dir = await mkdtemp(join(tmpdir(), "harness-arena-init-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("safe local init helpers", () => {
  it("rejects missing Node and pnpm before trying to start", () => {
    expect(() => validateStartup({ node: false, pnpm: true, portAvailable: true, stalePid: false })).toThrow(/Node/);
    expect(() => validateStartup({ node: true, pnpm: false, portAvailable: true, stalePid: false })).toThrow(/pnpm/);
  });

  it("fails for an occupied port and stale PID metadata", () => {
    expect(() => validateStartup({ node: true, pnpm: true, portAvailable: false, stalePid: false })).toThrow(/port/);
    expect(() => validateStartup({ node: true, pnpm: true, portAvailable: true, stalePid: true })).toThrow(/stale PID/);
  });

  it("derives stable distinct ports and only local-safe env per worktree", async () => {
    const first = await worktree();
    const second = await worktree();
    expect(choosePort(first)).toBe(choosePort(first));
    expect(choosePort(first)).not.toBe(choosePort(second));
    const env = localEnv(first);
    expect(env).toContain("STORAGE=file");
    expect(env).toContain("LOCAL_STORAGE_DIR=");
    expect(env).not.toMatch(/BLOB_READ_WRITE_TOKEN|VERCEL/);
  });

  it("writes an owner-only local env file without overwriting an existing operator file", async () => {
    const dir = await worktree();
    const path = await localEnv(dir, { write: true });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(localEnv(dir, { write: true })).rejects.toThrow(/already exists/);
  });

  it("never exposes a partial .env.local and recovers on retry after publication is interrupted", async () => {
    const dir = await worktree();
    const path = join(dir, ".env.local");
    await expect(localEnv(dir, {
      write: true,
      beforePublish: () => { throw new Error("injected env publication interruption"); },
    })).rejects.toThrow(/injected env publication interruption/);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await localEnv(dir, { write: true });
    expect(await readFile(path, "utf8")).toContain("# harness-arena-init:v2");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
