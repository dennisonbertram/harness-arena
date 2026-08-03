import { spawn } from "node:child_process";

const nonce = process.env.HARNESS_INIT_SUPERVISOR_NONCE;
let config;
try { config = JSON.parse(process.env.HARNESS_INIT_SUPERVISOR_CONFIG ?? ""); } catch {}
if (!nonce || !config || typeof config.command !== "string" || !Array.isArray(config.args)) {
  throw new Error("init process supervisor requires an authenticated command configuration");
}

let child;
let childSettled = false;
let detached = false;
let terminating = false;
let started = false;

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => beginTermination(signal));
process.on("message", (message) => {
  if (!message || message.nonce !== nonce) return;
  if (message.type === "start" && !started && !terminating) startCommand();
  else if (message.type === "terminate") beginTermination("SIGTERM", true);
  else if (message.type === "verify" && terminating) send({ type: "verified", nonce, supervisorPid: process.pid });
  else if (message.type === "detach" && started && !terminating) {
    detached = true;
    send({ type: "detached", nonce, supervisorPid: process.pid }, () => process.disconnect());
  }
});
process.on("disconnect", () => {
  if (!detached && !childSettled) beginTermination("SIGTERM");
});

send({ type: "supervisor-ready", nonce, supervisorPid: process.pid });

function startCommand() {
  started = true;
  const childEnv = { ...process.env };
  for (const key of ["HARNESS_INIT_SUPERVISOR_NONCE", "HARNESS_INIT_SUPERVISOR_CONFIG", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"]) delete childEnv[key];
  childEnv.HARNESS_INIT_SUPERVISOR_PID = String(process.pid);
  childEnv.HARNESS_INIT_LAUNCHER_PID = String(process.ppid);
  const stdio = Array.from({ length: config.stdioLength }, () => "inherit");
  try {
    child = spawn(config.command, config.args, { cwd: config.cwd, env: childEnv, stdio });
  } catch (error) {
    send({ type: "outcome", nonce, error: serializeError(error) }, () => process.exit(1));
    return;
  }
  child.once("spawn", () => send({ type: "started", nonce, supervisorPid: process.pid, commandPid: child.pid }));
  child.once("error", (error) => finishCommand({ error: serializeError(error) }));
  child.once("close", (code, signal) => finishCommand({ code, signal }));
}

function beginTermination(signal = "SIGTERM", authenticated = false) {
  if (terminating) return;
  terminating = true;
  send({ type: "terminating", nonce, supervisorPid: process.pid, authenticated });
  if (!child) {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    process.disconnect?.();
    return;
  }
  try { process.kill(-process.pid, signal); } catch { try { child.kill(signal); } catch {} }
  // If the authenticated parent disappears, the still-live group leader owns
  // the only safe numeric group identity and must finish cleanup itself.
  if (!process.connected) {
    setTimeout(() => {
      try { process.kill(-process.pid, "SIGKILL"); } catch { process.kill(process.pid, "SIGKILL"); }
    }, 500);
  }
}

function finishCommand(outcome) {
  if (childSettled) return;
  childSettled = true;
  send({ type: "outcome", nonce, ...outcome }, () => {
    if (terminating) return;
    // Stay group leader until the authenticated parent has observed the
    // outcome and asked us to clean the whole group. A detached/orphaned
    // supervisor owns that cleanup itself.
    if (process.connected) return;
    beginTermination("SIGTERM");
  });
}

function send(message, callback) {
  if (!process.connected) { callback?.(); return; }
  try { process.send(message, callback); } catch { callback?.(); }
}

function serializeError(error) {
  return { message: String(error?.message ?? error), code: error?.code };
}
