import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { choosePort, localEnv, validateStartup } from "./init-lib.mjs";

const worktree = resolve(process.cwd());
const state = join(worktree, ".harness-arena");
const pidPath = join(state, "init.pid");
const logPath = join(state, "init.log");
const args = new Set(process.argv.slice(2));
const json = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const exists = async (path) => access(path).then(() => true).catch(() => false);
const commandExists = (command) => new Promise((resolveCommand) => {
  const child = spawn(command, ["--version"], { stdio: "ignore" }); child.on("error", () => resolveCommand(false)); child.on("exit", (code) => resolveCommand(code === 0));
});
const available = (port) => new Promise((resolvePort) => {
  const server = createServer(); server.once("error", () => resolvePort(false)); server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)));
});
const localOnlyEnv = () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key === "BLOB_READ_WRITE_TOKEN" || key.startsWith("VERCEL")) delete env[key];
  return env;
};
let port = choosePort(worktree);
for (let offset = 0; offset < 100; offset++) {
  const candidate = 20000 + ((port - 20000 + offset) % 10000);
  if (await available(candidate)) { port = candidate; break; }
  if (offset === 99) throw new Error("no available deterministic local port found in the worktree range");
}

if (args.has("--reset")) {
  if (await exists(pidPath)) throw new Error("refusing reset while PID metadata exists; stop the app first");
  await rm(join(state, "local-data"), { recursive: true, force: true });
  json({ ok: true, mode: "reset", storage: join(state, "local-data") });
  process.exit(0);
}
if (!["--check", "--no-install"].every((arg) => args.has(arg) || !arg.startsWith("--")) && [...args].some((arg) => !["--check", "--no-install"].includes(arg))) throw new Error("usage: ./scripts/init.sh [--check] [--no-install] [--reset]");
const stalePid = await exists(pidPath);
validateStartup({ node: await commandExists("node"), pnpm: await commandExists("pnpm"), portAvailable: true, stalePid });
if (args.has("--check")) { json({ ok: true, mode: "check", port, storage: join(state, "local-data") }); process.exit(0); }
if (!(await exists(join(worktree, ".env.local")))) await localEnv(worktree, { write: true });
else {
  const existingEnv = await readFile(join(worktree, ".env.local"), "utf8");
  if (!existingEnv.includes("STORAGE=file") || !existingEnv.includes("LOCAL_STORAGE_DIR=")) throw new Error("existing .env.local is not init-managed; refusing to overwrite it");
}
if (!args.has("--no-install")) {
  await new Promise((resolveInstall, reject) => {
    const child = spawn("pnpm", ["install", "--frozen-lockfile"], { cwd: worktree, env: localOnlyEnv(), stdio: "inherit" });
    child.on("exit", (code) => code === 0 ? resolveInstall() : reject(new Error(`pnpm install failed (${code})`)));
  });
}
await mkdir(state, { recursive: true });
const env = { ...localOnlyEnv(), STORAGE: "file", LOCAL_STORAGE_DIR: join(state, "local-data") };
await new Promise((resolveSeed, reject) => {
  const child = spawn(process.execPath, ["scripts/seed-local.mjs"], { cwd: worktree, env, stdio: "inherit" });
  child.on("exit", (code) => code === 0 ? resolveSeed() : reject(new Error(`local seed failed (${code})`)));
});
const log = await import("node:fs").then(({ createWriteStream }) => createWriteStream(logPath, { flags: "a", mode: 0o600 }));
await new Promise((resolveLog, rejectLog) => { log.once("open", resolveLog); log.once("error", rejectLog); });
const child = spawn("pnpm", ["exec", "next", "dev", "--port", String(port)], { cwd: worktree, env, detached: true, stdio: ["ignore", log, log] });
await writeFile(pidPath, String(child.pid), { mode: 0o600 }); child.unref();
const url = `http://127.0.0.1:${port}/api/ready`;
for (let attempt = 0; attempt < 60; attempt++) { try { const response = await fetch(url); if (response.ok) { json({ ok: true, mode: "start", pid: child.pid, port, url, storage: env.LOCAL_STORAGE_DIR, log: logPath }); process.exit(0); } } catch {} await new Promise((resolveWait) => setTimeout(resolveWait, 250)); }
await rm(pidPath, { force: true });
throw new Error(`readiness timeout for ${url}; inspect ${logPath}`);
