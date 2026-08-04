#!/usr/bin/env node
// Dependency-free local-init guard. Keep this independent of the Next/TS task
// loader so `./scripts/init.sh` can reject a stale image lock before it starts
// installing or launching the development stack.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const worktree = path.resolve(process.cwd());
const tasksDir = path.join(worktree, "tasks");
const lockPath = path.join(worktree, "config", "task-image-lock.json");

function taskImages() {
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const source = readFileSync(path.join(tasksDir, entry.name, "task.toml"), "utf8");
      const image = /^docker_image = "([^"]+)"$/m.exec(source)?.[1];
      if (!image) throw new Error(`task image missing for ${entry.name}`);
      return { task_id: entry.name, lookup_ref: image };
    })
    .sort((a, b) => a.task_id.localeCompare(b.task_id));
}

function lockEntries(lock) {
  if (!lock || lock.version !== 1 || !Array.isArray(lock.images)) throw new Error("task image lock invalid");
  const entries = lock.images.map(({ task_id, lookup_ref }) => ({ task_id, lookup_ref }));
  entries.sort((a, b) => a.task_id.localeCompare(b.task_id));
  return entries;
}

const expected = taskImages();
const actual = lockEntries(JSON.parse(readFileSync(lockPath, "utf8")));
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error("task image lock does not exactly match the derived task manifest");
}
process.stdout.write(`${JSON.stringify({ ok: true, task_image_lock_entries: actual.length })}\n`);
