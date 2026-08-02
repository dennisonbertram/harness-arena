import { execFile, spawn as spawnProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { verifyDevelopmentEnvironment } from "../ci/verify-development-environment.mjs";

const execFileAsync = promisify(execFile);

export const DEVELOPMENT_PROJECT_ID = "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA";
export const LIVE_PROJECT_ID = "prj_f4ppu0xpO0LZeHOAH99RHotVbwyo";
export const MAX_OUTPUT_BYTES = 65_536;
export const OPERATION_TIMEOUT_MS = 30_000;

const ALLOWED_OPERATIONS = new Map([
  ["deploy", ["deploy", "--yes", "--target", "development"]],
]);

function denied() {
  return new Error("Development Vercel operation denied by local safety policy");
}

function isApprovedBranch(branch) {
  return branch === "dev" || /^codex\/[a-z0-9][a-z0-9._-]*$/i.test(branch);
}

async function defaultReadManifest(cwd) {
  const raw = await readFile(path.join(cwd, "config/development-environment.json"), "utf8");
  return JSON.parse(raw);
}

async function defaultReadLinkedProject(cwd) {
  const raw = await readFile(path.join(cwd, ".vercel/project.json"), "utf8");
  return JSON.parse(raw);
}

async function defaultGitState(cwd) {
  const options = { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: MAX_OUTPUT_BYTES, shell: false };
  const [{ stdout: branch }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["branch", "--show-current"], options),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], options),
  ]);
  return { branch: branch.trim(), isClean: status.trim() === "" };
}

/**
 * Spawn without a shell and retain only a bounded amount of output.  Callers
 * deliberately receive no CLI text on failure: CLI output can contain URLs or
 * values supplied by an operator, so failures remain safe to paste into logs.
 */
function spawnBounded(file, args, { cwd, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve) => {
    const child = spawnProcess(file, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current, chunk) => {
      const remaining = Math.max(0, maxOutputBytes - Buffer.byteLength(current));
      return remaining === 0 ? current : current + chunk.toString("utf8", 0, remaining);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: 1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1, timedOut });
    });
  });
}

/**
 * The only mutation path for the reserved development Vercel project.  Its
 * intentionally tiny public input (`operation`) prevents option injection;
 * adding another mutation requires a reviewed entry in ALLOWED_OPERATIONS and
 * hostile pre-spawn coverage.
 */
export async function runDevelopmentVercelOperation({
  operation,
  cwd = process.cwd(),
  readManifest = defaultReadManifest,
  readLinkedProject = defaultReadLinkedProject,
  gitState = defaultGitState,
  spawn = spawnBounded,
} = {}) {
  const argv = ALLOWED_OPERATIONS.get(operation);
  if (!argv) throw denied();

  let manifest;
  let linkedProject;
  let state;
  try {
    [manifest, linkedProject, state] = await Promise.all([
      readManifest(cwd),
      readLinkedProject(cwd),
      gitState(cwd),
    ]);
  } catch {
    throw denied();
  }

  const verification = verifyDevelopmentEnvironment({ development: manifest, live: manifest?.live });
  if (
    !verification.ok
    || manifest?.vercelProject?.id !== DEVELOPMENT_PROJECT_ID
    || linkedProject?.projectId !== DEVELOPMENT_PROJECT_ID
    || linkedProject.projectId === LIVE_PROJECT_ID
    || !state
    || state.isClean !== true
    || typeof state.branch !== "string"
    || !isApprovedBranch(state.branch)
  ) {
    throw denied();
  }

  let result;
  try {
    result = await spawn("vercel", [...argv], {
      cwd,
      shell: false,
      timeoutMs: OPERATION_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
  } catch {
    throw new Error("Development Vercel operation failed");
  }

  if (!result || result.code !== 0 || result.timedOut) {
    const suffix = typeof result?.code === "number" ? ` (exit ${result.code})` : "";
    throw new Error(`Development Vercel operation failed${suffix}`);
  }

  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function main() {
  if (process.argv.length !== 3) throw denied();
  const result = await runDevelopmentVercelOperation({ operation: process.argv[2] });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
