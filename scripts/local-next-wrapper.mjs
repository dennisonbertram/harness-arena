import { spawn } from "node:child_process";

const [nextBin, ...nextArgs] = process.argv.slice(2);
if (!nextBin) throw new Error("local Next wrapper requires the Next CLI path");
const child = spawn(process.execPath, [nextBin, ...nextArgs], {
  env: { ...process.env, LOCAL_INSTANCE_PID: String(process.pid) },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { try { child.kill(signal); } catch {} });
child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
