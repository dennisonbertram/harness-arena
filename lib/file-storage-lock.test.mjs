import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots = [];
const children = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitForCount(path, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await readdir(path).then((entries) => entries.length).catch(() => 0);
    if (count === expected) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${expected} contenders`);
}

async function runRound(root, round, count = 20) {
  const lock = join(root, `shared-${round}.lock`);
  const ready = join(root, `ready-${round}`);
  const gate = join(root, `gate-${round}`);
  const events = join(root, `events-${round}.log`);
  await mkdir(lock, { recursive: true });
  await mkdir(ready, { recursive: true });
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 99999999, token: "stale", created_at_ms: 1 }));

  const exits = Array.from({ length: count }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/tests/file-storage-lock-worker.mjs", lock, ready, gate, events, String(index)], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
    children.add(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => {
      children.delete(child);
      if (code === 0) resolve(); else reject(new Error(`lock worker ${index} failed (${code}): ${stderr}`));
    });
    child.once("error", reject);
  }));
  await waitForCount(ready, count);
  await writeFile(gate, "go");
  await Promise.all(exits);

  const active = new Set();
  const overlaps = [];
  for (const line of (await readFile(events, "utf8")).trim().split("\n")) {
    const [kind, id] = line.split(" ");
    if (kind === "enter") {
      if (active.size) overlaps.push([id, ...active]);
      active.add(id);
    } else active.delete(id);
  }
  return { overlaps, active: [...active] };
}

describe("directory lock stale recovery", () => {
  it("serializes 20 contenders across repeated stale-lock ABA races", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-arena-lock-stress-"));
    roots.push(root);
    for (let round = 0; round < 5; round++) {
      await expect(runRound(root, round)).resolves.toEqual({ overlaps: [], active: [] });
    }
  }, 60_000);
});
