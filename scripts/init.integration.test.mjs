import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = process.cwd();
const state = `${root}/.harness-arena`;
const ownedPids = new Set();

function runInit(...args) {
  return runInitWithEnv({}, ...args);
}

function runInitWithEnv(extraEnv, ...args) {
  return new Promise((resolve) => {
    const child = spawn("./scripts/init.sh", args, { cwd: root, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, BLOB_READ_WRITE_TOKEN: "inherited-blob-sentinel", RANDOM_PARENT_SECRET: "parent-sentinel", ...extraEnv } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(path, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForProcessGroupExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for process group ${pid} to exit`);
}

afterAll(async () => {
  for (const pid of ownedPids) { try { process.kill(-pid, "SIGTERM"); } catch {} }
  await rm(`${state}/init.pid`, { force: true });
  await rm(`${state}/init.lock`, { recursive: true, force: true });
  await rm(`${root}/.env`, { force: true });
});

describe.sequential("init process ownership integration", () => {
  it("makes simultaneous starts converge on one live owned instance and makes rerun/check idempotent", async () => {
    await rm(`${state}/init.pid`, { force: true });
    await rm(`${state}/init.lock`, { recursive: true, force: true });
    await writeFile(`${root}/.env`, "AI_GATEWAY_API_KEY=gateway-env-sentinel\nRUNNER_CALLBACK_SECRET=runner-env-sentinel\nHARMLESS_SENTINEL=harmless-env-sentinel\n");
    const [a, b] = await Promise.all([runInit("--no-install"), runInit("--no-install")]);
    for (const result of [a, b].filter((candidate) => candidate.code === 0)) ownedPids.add(JSON.parse(result.stdout.trim().split("\n").at(-1)).pid);
    expect([a.code, b.code]).toEqual([0, 0]);
    const first = JSON.parse(a.stdout.trim().split("\n").at(-1));
    const second = JSON.parse(b.stdout.trim().split("\n").at(-1));
    ownedPids.add(first.pid);
    expect(second.pid).toBe(first.pid);
    expect(second.nonce).toBe(first.nonce);
    expect(new Set([first.mode, second.mode])).toEqual(new Set(["start", "existing"]));
    const ready = await fetch(first.url).then((response) => response.json());
    expect(ready).toMatchObject({ ok: true, pid: first.pid, nonce: first.nonce, seeded: true, writable: true, environment_sanitized: true });

    const rerun = await runInit("--no-install");
    const check = await runInit("--check");
    expect(JSON.parse(rerun.stdout.trim()).mode).toBe("existing");
    expect(JSON.parse(check.stdout.trim()).mode).toBe("existing");
  }, 30000);

  it("does not expose inherited or env-file sentinel values through health", async () => {
    const metadata = JSON.parse(await readFile(`${state}/init.pid`, "utf8"));
    const health = await fetch(`http://127.0.0.1:${metadata.port}/api/health`).then((response) => response.text());
    expect(health).not.toMatch(/sentinel/);
    expect(JSON.parse(health)).toMatchObject({ gateway_key_present: false, runner_secret_present: false });
  });

  it("lets a simultaneous caller outwait a cold install and report the same owned instance", async () => {
    const prior = await readFile(`${state}/init.pid`, "utf8").then(JSON.parse, () => undefined);
    if (prior) {
      try { process.kill(-prior.pid, "SIGTERM"); } catch {}
      ownedPids.delete(prior.pid);
      await waitForProcessGroupExit(prior.pid);
    }
    await rm(`${state}/init.pid`, { force: true });

    const fakeRoot = await mkdtemp(join(tmpdir(), "harness-arena-slow-pnpm-"));
    const fakeBin = join(fakeRoot, "bin");
    const marker = join(fakeRoot, "install-started");
    await mkdir(fakeBin);
    const fakePnpm = join(fakeBin, "pnpm");
    await writeFile(fakePnpm, [
      "#!/usr/bin/env node",
      "import { writeFile } from 'node:fs/promises';",
      "if (process.argv[2] === '--version') { console.log('10.0.0'); process.exit(0); }",
      `if (process.argv[2] === 'install') { await writeFile(${JSON.stringify(marker)}, 'started'); await new Promise((resolve) => setTimeout(resolve, 16_000)); process.exit(0); }`,
      "process.exit(2);",
    ].join("\n"));
    await chmod(fakePnpm, 0o700);
    const env = { PATH: `${fakeBin}:${process.env.PATH}` };

    try {
      const owner = runInitWithEnv(env);
      await waitForFile(marker);
      const simultaneous = runInitWithEnv(env, "--no-install");
      const [first, second] = await Promise.all([owner, simultaneous]);
      for (const result of [first, second].filter((candidate) => candidate.code === 0)) {
        ownedPids.add(JSON.parse(result.stdout.trim().split("\n").at(-1)).pid);
      }
      expect([first.code, second.code]).toEqual([0, 0]);
      const firstInstance = JSON.parse(first.stdout.trim().split("\n").at(-1));
      const secondInstance = JSON.parse(second.stdout.trim().split("\n").at(-1));
      ownedPids.add(firstInstance.pid);
      expect(firstInstance).toMatchObject({ mode: "start" });
      expect(secondInstance).toMatchObject({ mode: "existing", pid: firstInstance.pid, nonce: firstInstance.nonce });
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
