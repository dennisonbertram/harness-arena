import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetLocalData } from "./init-lib.mjs";

const roots = [];
const processGroups = new Set();
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

afterEach(async () => {
  for (const pid of processGroups) { try { process.kill(-pid, "SIGKILL"); } catch {} }
  processGroups.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(path, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await delay(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForJson(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for complete JSON at ${path}`);
}

describe("detached local ownership handoff", () => {
  it("publishes wrapper ownership before Next starts when the launcher dies immediately after spawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-arena-wrapper-handoff-"));
    roots.push(root);
    const state = join(root, ".harness-arena");
    const data = join(state, "local-data");
    const marker = join(root, "fake-next-started.json");
    const wrapperPidPath = join(root, "wrapper.pid");
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "keep.txt"), "keep");

    const fakeNext = join(root, "fake-next.mjs");
    await writeFile(fakeNext, [
      "import { readFile, writeFile } from 'node:fs/promises';",
      `const state = ${JSON.stringify(state)};`,
      `const marker = ${JSON.stringify(marker)};`,
      "let metadata;",
      "try { metadata = JSON.parse(await readFile(`${state}/init.pid`, 'utf8')); } catch {}",
      "await writeFile(marker, JSON.stringify({ metadataAtStart: metadata?.pid === process.ppid, metadata }));",
      "setInterval(() => {}, 1000);",
    ].join("\n"));

    const launcher = join(root, "launcher.mjs");
    const wrapper = resolve("scripts/local-next-wrapper.mjs");
    await writeFile(launcher, [
      "import { spawn } from 'node:child_process';",
      "import { writeFile } from 'node:fs/promises';",
      `const child = spawn(process.execPath, [${JSON.stringify(wrapper)}, ${JSON.stringify(fakeNext)}], {`,
      "  detached: true,",
      "  stdio: 'ignore',",
      `  env: { PATH: process.env.PATH, HARNESS_INIT_STATE: ${JSON.stringify(state)}, LOCAL_INSTANCE_NONCE: 'handoff-nonce', LOCAL_INSTANCE_PORT: '29991' },`,
      "});",
      `await writeFile(${JSON.stringify(wrapperPidPath)}, String(child.pid));`,
      "child.unref();",
      "process.exit(23);",
    ].join("\n"));

    const launcherChild = spawn(process.execPath, [launcher], { stdio: "ignore" });
    const launcherExit = await new Promise((resolveExit, reject) => {
      launcherChild.once("error", reject);
      launcherChild.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    expect(launcherExit).toEqual({ code: 23, signal: null });
    const wrapperPid = Number.parseInt(await waitForFile(wrapperPidPath), 10);
    processGroups.add(wrapperPid);
    const started = await waitForJson(marker);
    const reset = await resetLocalData(root).then(
      (value) => ({ status: "resolved", value }),
      (error) => ({ status: "rejected", message: error.message }),
    );

    expect({ started, reset }).toMatchObject({
      started: { metadataAtStart: true, metadata: { pid: wrapperPid, nonce: "handoff-nonce", port: 29991 } },
      reset: { status: "rejected", message: expect.stringMatching(/running|live/i) },
    });
    await expect(readFile(join(data, "keep.txt"), "utf8")).resolves.toBe("keep");
  }, 10_000);
});
