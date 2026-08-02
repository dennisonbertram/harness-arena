import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as init from "./init-lib.mjs";

const dirs = [];
async function temp(prefix = "harness-init-security-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("init security and lifecycle", () => {
  it("uses a strict child allowlist and preempts every key discovered in Next auto-loaded env files", async () => {
    const root = await temp();
    await writeFile(join(root, ".env"), "BLOB_READ_WRITE_TOKEN=blob-sentinel\nHARMLESS_SENTINEL=env-sentinel\n");
    await writeFile(join(root, ".env.development.local"), "AI_GATEWAY_API_KEY=gateway-sentinel\n");
    const child = await init.safeChildEnv(root, {
      PATH: process.env.PATH,
      BLOB_READ_WRITE_TOKEN: "inherited-blob-sentinel",
      VERCEL: "1",
      RANDOM_PARENT_SECRET: "parent-sentinel",
    }, { AUTH_SECRET: "local-auth", LOCAL_STORAGE_DIR: join(root, "data"), LOCAL_INSTANCE_NONCE: "nonce" });

    expect(child).toMatchObject({ STORAGE: "file", AUTH_SECRET: "local-auth", LOCAL_INSTANCE_NONCE: "nonce" });
    expect(Object.values(child).join(" ")).not.toMatch(/sentinel/);
    expect(child.BLOB_READ_WRITE_TOKEN).toBe("");
    expect(child.AI_GATEWAY_API_KEY).toBe("");
    expect(child.HARMLESS_SENTINEL).toBe("");
    expect(child.VERCEL).toBeUndefined();
    expect(child.RANDOM_PARENT_SECRET).toBeUndefined();
  });

  it("enforces Next 16.2.11's complete Node >=20.9.0 semver floor and probes the selected port", async () => {
    for (const version of ["19.9.0", "20.8.999", "20.9", "20", "garbage", "", "20.9.0.1"]) {
      expect(() => init.assertNodeVersion(version), version).toThrow(/Node\.js 20(?:\.9\.0)?\+/);
    }
    expect(() => init.assertNodeVersion("20.9.0")).not.toThrow();
    expect(() => init.assertNodeVersion("21.0.0")).not.toThrow();
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await expect(init.isPortAvailable(port)).resolves.toBe(false);
    await new Promise((resolve) => server.close(resolve));
    await expect(init.isPortAvailable(port)).resolves.toBe(true);
  });

  it("refuses reset when state or data is symlinked and never deletes the outside target", async () => {
    const root = await temp();
    const outside = await temp("harness-init-outside-");
    await writeFile(join(outside, "keep.txt"), "keep");
    await symlink(outside, join(root, ".harness-arena"));
    await expect(init.resetLocalData(root)).rejects.toThrow(/symlink|confined/i);
    await expect(readFile(join(outside, "keep.txt"), "utf8")).resolves.toBe("keep");

    await rm(join(root, ".harness-arena"));
    await mkdir(join(root, ".harness-arena"));
    await symlink(outside, join(root, ".harness-arena", "local-data"));
    await expect(init.resetLocalData(root)).rejects.toThrow(/symlink|confined/i);
    await expect(readFile(join(outside, "keep.txt"), "utf8")).resolves.toBe("keep");
  });

  it("fails closed on a live legacy numeric PID and preserves local data", async () => {
    const root = await temp();
    const state = join(root, ".harness-arena");
    const data = join(state, "local-data");
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "keep.txt"), "keep");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    try {
      await writeFile(join(state, "init.pid"), String(child.pid));
      await expect(init.resetLocalData(root)).rejects.toThrow(new RegExp(`live|running|${child.pid}`, "i"));
      await expect(readFile(join(data, "keep.txt"), "utf8")).resolves.toBe("keep");
    } finally {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });

  it("recovers a stale legacy numeric PID with the same explicit recovery evidence", async () => {
    const root = await temp();
    const state = join(root, ".harness-arena");
    const data = join(state, "local-data");
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "remove.txt"), "remove");
    await writeFile(join(state, "init.pid"), "99999999");
    const canonicalData = join(await realpath(root), ".harness-arena", "local-data");

    await expect(init.resetLocalData(root)).resolves.toMatchObject({ removed: true, stale_pid_recovered: true, storage: canonicalData });
    await expect(stat(join(state, "init.pid"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(data)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses reset when any nested local-data component is a symlink", async () => {
    const root = await temp();
    const outside = await temp("harness-init-nested-outside-");
    const data = join(root, ".harness-arena", "local-data");
    await mkdir(data, { recursive: true });
    await writeFile(join(outside, "keep.txt"), "keep");
    await symlink(outside, join(data, "traces"));

    await expect(init.resetLocalData(root)).rejects.toThrow(/symlink|confined/i);
    await expect(readFile(join(outside, "keep.txt"), "utf8")).resolves.toBe("keep");
    expect((await stat(data)).isDirectory()).toBe(true);
  });

  it("recovers a bounded stale init lock but never steals a live owner's lock", async () => {
    const root = await temp();
    const lock = join(root, "init.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 99999999, created_at_ms: 1 }));
    const release = await init.acquireInitLock(lock, { staleMs: 1, timeoutMs: 500 });
    expect((await stat(lock)).isDirectory()).toBe(true);
    await release();

    await rm(lock, { recursive: true, force: true });
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, created_at_ms: Date.now() }));
    await expect(init.acquireInitLock(lock, { staleMs: 1, timeoutMs: 30 })).rejects.toThrow(/lock timeout/);
  });

  it("retains secret-safe failure evidence while terminating a timed-out process group", async () => {
    const root = await temp();
    const child = init.spawnProcessGroup(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { cwd: root, env: { PATH: process.env.PATH } });
    await init.failTimedOutStart({ worktree: root, pid: child.pid, nonce: "nonce-1", port: 29999, logPath: join(root, "safe.log") });
    expect(init.isProcessAlive(child.pid)).toBe(false);
    const failure = JSON.parse(await readFile(join(root, ".harness-arena", "init-failure.json"), "utf8"));
    expect(failure).toMatchObject({ nonce: "nonce-1", pid: child.pid, port: 29999, reason: "readiness_timeout" });
    expect(JSON.stringify(failure)).not.toMatch(/TOKEN|SECRET|KEY=/);
  });
});
