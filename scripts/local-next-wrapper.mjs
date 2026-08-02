import { writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { removeInstanceMetadataIfOwned, writeInstanceMetadata } from "./init-lib.mjs";

const [nextBin, ...nextArgs] = process.argv.slice(2);
const state = process.env.HARNESS_INIT_STATE;
const nonce = process.env.LOCAL_INSTANCE_NONCE;
const port = Number.parseInt(process.env.LOCAL_INSTANCE_PORT ?? "", 10);
if (!nextBin) throw new Error("local Next wrapper requires the Next CLI path");
if (!state || !nonce || !Number.isSafeInteger(port) || port <= 0) throw new Error("local Next wrapper requires complete ownership metadata");

const instance = { pid: process.pid, nonce, port, started_at: new Date().toISOString() };
let requestedSignal;
let finalized = false;
let child;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    requestedSignal = signal;
    if (child) { try { child.kill(signal); } catch {} }
  });
}

// The wrapper is the detached process-group leader. Publish and fsync that
// durable ownership before a Next process can exist, so a launcher crash can
// never leave an untracked live server.
await writeInstanceMetadata(state, instance);
try {
  writeSync(3, `${JSON.stringify({ type: "ownership-durable", pid: instance.pid, nonce, port })}\n`);
} catch (error) {
  // The real launcher provides fd 3. A closed channel means the launcher died
  // after spawn; durable ownership is already established, so startup remains
  // safe and independently recoverable.
  if (error?.code !== "EBADF" && error?.code !== "EPIPE" && error?.code !== "EINVAL" && error?.code !== "ENXIO") {
    await removeInstanceMetadataIfOwned(state, instance).catch(() => {});
    throw error;
  }
}
if (requestedSignal) {
  await finalize(1);
  await new Promise(() => {});
}

try {
  child = spawn(process.execPath, [nextBin, ...nextArgs], {
    env: { ...process.env, LOCAL_INSTANCE_PID: String(process.pid) },
    stdio: "inherit",
  });
} catch (error) {
  await finalize(1);
  throw error;
}
child.once("error", async (error) => {
  console.error(error);
  await finalize(1);
});
child.once("exit", async (code, signal) => {
  if (signal && !requestedSignal) requestedSignal = signal;
  await finalize(code ?? 1);
});

async function finalize(code) {
  if (finalized) return;
  finalized = true;
  await removeInstanceMetadataIfOwned(state, instance).catch(() => {});
  if (requestedSignal) {
    process.removeAllListeners(requestedSignal);
    process.kill(process.pid, requestedSignal);
    return;
  }
  process.exit(code);
}
