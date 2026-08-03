import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { issueBodyForAction } from "./passive-monitor.mjs";

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { shell: false, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`gh_issue_operation_failed:${code}:${stderr.slice(0, 200)}`)));
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

for (const file of process.argv.slice(2)) {
  const plan = JSON.parse(await readFile(file, "utf8"));
  for (const action of plan.actions ?? []) {
    const body = issueBodyForAction(action, plan.observation);
    if (action.action === "create") await run(["issue", "create", "--title", `[agent-monitor] ${plan.observation.environment}: ${action.failure.alert_class}/${action.failure.code}`, "--body-file", "-"], body);
    else if (action.action === "reopen") { await run(["issue", "reopen", String(action.number)]); await run(["issue", "comment", String(action.number), "--body-file", "-"], body); await run(["issue", "edit", String(action.number), "--body-file", "-"], body); }
    else if (action.action === "comment") { await run(["issue", "comment", String(action.number), "--body-file", "-"], body); await run(["issue", "edit", String(action.number), "--body-file", "-"], body); }
    else if (action.action === "close") { await run(["issue", "comment", String(action.number), "--body-file", "-"], body); await run(["issue", "close", String(action.number)]); }
  }
}
