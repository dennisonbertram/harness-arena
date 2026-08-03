import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ANCHOR_PATH = fileURLToPath(new URL("./init-command-group-anchor.mjs", import.meta.url));
const nonce = process.env.HARNESS_INIT_SUPERVISOR_NONCE;
let config;
try { config = JSON.parse(process.env.HARNESS_INIT_SUPERVISOR_CONFIG ?? ""); } catch {}
if (!nonce || !config || typeof config.command !== "string" || !Array.isArray(config.args)) {
  throw new Error("init process supervisor requires an authenticated command configuration");
}

let anchor;
let anchorNonce;
let commandPid;
let detachPrepared = false;
let detached = false;
let detachPromise;
let cleanupPromise;
let cleanupRequest;
let outcomeSent = false;
let started = false;

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void beginCleanup(signal); });
process.on("disconnect", () => {
  if (detachPrepared && !cleanupRequest) void commitDetach();
  else void beginCleanup("SIGTERM");
});
process.on("message", (message) => {
  if (!message || message.nonce !== nonce) return;
  if (message.type === "start" && !started && !detachPromise && !cleanupPromise) startAnchor();
  else if (message.type === "terminate") void beginCleanup("SIGTERM", true, message);
  else if (message.type === "detach" && started && !detachPromise && !cleanupPromise) void beginDetach();
});

send({ type: "supervisor-ready", nonce, supervisorPid: process.pid });

function startAnchor() {
  started = true;
  anchorNonce = randomUUID();
  const anchorConfig = JSON.stringify({ ...config, supervisorPid: process.pid, launcherPid: process.ppid });
  const anchorEnv = { ...process.env, HARNESS_INIT_ANCHOR_NONCE: anchorNonce, HARNESS_INIT_ANCHOR_CONFIG: anchorConfig };
  const stdio = [...Array.from({ length: config.stdioLength }, () => "inherit"), "ipc"];
  try {
    anchor = spawn(process.execPath, [ANCHOR_PATH], { cwd: config.cwd, detached: true, env: anchorEnv, stdio });
  } catch (error) {
    emitOutcome({ error: serializeError(error) });
    return;
  }
  anchor.on("message", onAnchorMessage);
  anchor.once("error", (error) => emitOutcome({ error: serializeError(error) }));
  anchor.once("exit", (code, signal) => {
    if (!outcomeSent) emitOutcome({ error: { message: `command group anchor exited before command outcome (${signal ?? code})` } });
    if (!cleanupPromise && !detached) process.exitCode = 1;
    if (detached) process.exit(code ?? 1);
  });
}

function onAnchorMessage(message) {
  if (!message || message.nonce !== anchorNonce || message.anchorPid !== anchor?.pid) return;
  if (message.type === "anchor-ready") {
    try { anchor.send({ type: "start", nonce: anchorNonce }); } catch (error) { emitOutcome({ error: serializeError(error) }); }
  } else if (message.type === "started") {
    commandPid = message.commandPid;
    send({ type: "started", nonce, supervisorPid: process.pid, groupPid: anchor.pid, commandPid });
  } else if (message.type === "outcome") {
    emitOutcome(message.error ? { error: message.error } : { code: message.code, signal: message.signal });
  }
}

function emitOutcome(outcome) {
  if (outcomeSent) return;
  outcomeSent = true;
  send({ type: "outcome", nonce, supervisorPid: process.pid, ...outcome });
}

function beginCleanup(signal = "SIGTERM", authenticated = false, settings = {}) {
  cleanupRequest ??= { signal, authenticated, settings };
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (detachPromise) await detachPromise.catch(() => false);
    detachPrepared = false;
    detached = false;
    const requested = cleanupRequest;
    return cleanupGroup(requested.signal, requested.authenticated, requested.settings);
  })().catch(() => false).then((reaped) => {
    if (reaped) {
      send({ type: "group-reaped", nonce, supervisorPid: process.pid, groupPid: anchor?.pid }, () => process.exit(0));
    } else {
      process.exitCode = 1;
      process.disconnect?.();
    }
    return reaped;
  });
  return cleanupPromise;
}

async function cleanupGroup(signal, authenticated, settings) {
  send({ type: "terminating", nonce, supervisorPid: process.pid, groupPid: anchor?.pid, authenticated });
  if (!anchor) return true;
  const graceMs = positiveTimeout(settings.graceMs, 500);
  const killWaitMs = positiveTimeout(settings.killWaitMs, 1_000);
  if (!await verifyAnchor(Math.min(250, killWaitMs)) || !liveChild(anchor)) return false;
  try { process.kill(-anchor.pid, signal); } catch { return false; }
  await delay(graceMs);
  if (!await verifyAnchor(Math.min(250, killWaitMs)) || !liveChild(anchor)) return false;
  try { process.kill(-anchor.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") return false; }
  const [anchorGone, commandGone, groupGone] = await Promise.all([
    waitForChildExit(anchor, killWaitMs),
    waitForPidExit(commandPid, killWaitMs),
    waitForGroupExit(anchor.pid, killWaitMs),
  ]);
  return anchorGone && commandGone && groupGone;
}

function verifyAnchor(timeoutMs) {
  if (!liveChild(anchor) || !anchor.connected) return Promise.resolve(false);
  return waitForAnchorMessage("verified", timeoutMs, () => anchor.send({ type: "verify", nonce: anchorNonce }));
}

async function beginDetach() {
  if (detachPromise || cleanupPromise || cleanupRequest) return false;
  detachPromise = (async () => {
    if (!anchor || !await verifyAnchor(250)) return false;
    const acknowledged = await waitForAnchorMessage("detach-ready", 500, () => anchor.send({ type: "prepare-detach", nonce: anchorNonce }));
    if (!acknowledged || !liveChild(anchor) || cleanupRequest) return false;
    detachPrepared = true;
    send({ type: "detached", nonce, supervisorPid: process.pid, groupPid: anchor.pid });
    return true;
  })();
  const succeeded = await detachPromise;
  detachPromise = undefined;
  return succeeded;
}

async function commitDetach() {
  if (!anchor || !liveChild(anchor)) {
    detachPrepared = false;
    void beginCleanup("SIGTERM");
    return;
  }
  const committed = await waitForAnchorMessage("detached", 500, () => anchor.send({ type: "commit-detach", nonce: anchorNonce }));
  if (committed) {
    detachPrepared = false;
    detached = true;
  } else {
    detachPrepared = false;
    void beginCleanup("SIGTERM");
  }
}

function waitForAnchorMessage(type, timeoutMs, request) {
  return new Promise((resolveMatched) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    const onMessage = (message) => {
      if (message?.type === type && message.nonce === anchorNonce && message.anchorPid === anchor.pid) finish(true);
    };
    const onExit = () => finish(false);
    anchor.on("message", onMessage);
    anchor.once("exit", onExit);
    try { request(); } catch { finish(false); }
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      anchor.off("message", onMessage);
      anchor.off("exit", onExit);
      resolveMatched(value);
    }
  });
}

function liveChild(child) { return child && child.exitCode === null && child.signalCode === null; }

function waitForChildExit(child, timeoutMs) {
  if (!liveChild(child)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    function onExit() { finish(true); }
    function finish(value) { clearTimeout(timer); child.off("exit", onExit); resolveExit(value); }
  });
}

async function waitForPidExit(pid, timeoutMs) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await delay(10);
  }
  return !pidAlive(pid);
}

async function waitForGroupExit(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true;
    await delay(10);
  }
  return !groupAlive(pgid);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function positiveTimeout(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

function send(message, callback) {
  if (!process.connected) { callback?.(); return; }
  try { process.send(message, callback); } catch { callback?.(); }
}

function serializeError(error) {
  return { message: String(error?.message ?? error), code: error?.code };
}
