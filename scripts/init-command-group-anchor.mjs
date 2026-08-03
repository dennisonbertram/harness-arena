import { spawn } from "node:child_process";

const nonce = process.env.HARNESS_INIT_ANCHOR_NONCE;
let config;
try { config = JSON.parse(process.env.HARNESS_INIT_ANCHOR_CONFIG ?? ""); } catch {}
if (!nonce || !config || typeof config.command !== "string" || !Array.isArray(config.args)) {
  throw new Error("init command group anchor requires an authenticated command configuration");
}

let child;
let childSettled = false;
let durable = false;
let selfTerminating = false;
let started = false;

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  if (durable) beginSelfTermination(signal);
});
process.on("disconnect", () => beginSelfTermination("SIGTERM"));
process.on("message", (message) => {
  if (!message || message.nonce !== nonce) return;
  if (message.type === "start" && !started && !selfTerminating) startCommand();
  else if (message.type === "verify" && !selfTerminating) send({ type: "verified", nonce, anchorPid: process.pid });
  else if (message.type === "detach" && started && !selfTerminating) {
    durable = true;
    send({ type: "detached", nonce, anchorPid: process.pid });
  }
});

send({ type: "anchor-ready", nonce, anchorPid: process.pid });

function startCommand() {
  started = true;
  const childEnv = { ...process.env };
  for (const key of [
    "HARNESS_INIT_ANCHOR_NONCE", "HARNESS_INIT_ANCHOR_CONFIG",
    "HARNESS_INIT_SUPERVISOR_NONCE", "HARNESS_INIT_SUPERVISOR_CONFIG",
    "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE",
  ]) delete childEnv[key];
  childEnv.HARNESS_INIT_SUPERVISOR_PID = String(config.supervisorPid);
  childEnv.HARNESS_INIT_LAUNCHER_PID = String(config.launcherPid);
  const stdio = Array.from({ length: config.stdioLength }, () => "inherit");
  try {
    child = spawn(config.command, config.args, { cwd: config.cwd, env: childEnv, stdio });
  } catch (error) {
    finishCommand({ error: serializeError(error) });
    return;
  }
  child.once("spawn", () => send({ type: "started", nonce, anchorPid: process.pid, commandPid: child.pid }));
  child.once("error", (error) => finishCommand({ error: serializeError(error) }));
  child.once("close", (code, signal) => finishCommand({ code, signal }));
}

function finishCommand(outcome) {
  if (childSettled) return;
  childSettled = true;
  send({ type: "outcome", nonce, anchorPid: process.pid, ...outcome });
}

function beginSelfTermination(signal) {
  if (selfTerminating) return;
  selfTerminating = true;
  try { process.kill(-process.pid, signal); } catch {}
  const timer = setTimeout(() => {
    try { process.kill(-process.pid, "SIGKILL"); } catch { process.kill(process.pid, "SIGKILL"); }
  }, 500);
  timer.unref();
}

function send(message, callback) {
  if (!process.connected) { callback?.(); return; }
  try { process.send(message, callback); } catch { callback?.(); }
}

function serializeError(error) {
  return { message: String(error?.message ?? error), code: error?.code };
}
