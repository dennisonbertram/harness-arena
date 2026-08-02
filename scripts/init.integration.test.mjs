import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";

const root = process.cwd();
const state = `${root}/.harness-arena`;
const ownedPids = new Set();

function runInit(...args) {
  return new Promise((resolve) => {
    const child = spawn("./scripts/init.sh", args, { cwd: root, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, BLOB_READ_WRITE_TOKEN: "inherited-blob-sentinel", RANDOM_PARENT_SECRET: "parent-sentinel" } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
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
});
