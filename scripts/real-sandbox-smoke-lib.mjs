import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "config/development-environment.json"), "utf8"));
const MAX_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 2 * 60_000;

export async function runRealSandboxSmoke({ env = process.env, create }) {
  if (typeof create !== "function") throw new Error("real Sandbox smoke requires a Sandbox.create adapter");
  if (!env.VERCEL_TOKEN || !env.VERCEL_TEAM_ID) throw new Error("real Sandbox smoke requires local VERCEL_TOKEN and VERCEL_TEAM_ID credentials");
  if (env.VERCEL_PROJECT_ID !== manifest.vercelProject.id || env.VERCEL_PROJECT_ID === manifest.live.projectId) {
    throw new Error("real Sandbox smoke requires the isolated Development project ID");
  }
  if (!env.HARNESS_GIT_BRANCH || env.HARNESS_GIT_BRANCH === "main") throw new Error("real Sandbox smoke is forbidden on main");
  const requested = Number(env.REAL_SANDBOX_SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(requested) || requested <= 0 || requested > MAX_TIMEOUT_MS) {
    throw new Error(`real Sandbox smoke timeout must be between 1 and ${MAX_TIMEOUT_MS}ms`);
  }

  let sandbox;
  try {
    sandbox = await create({
      runtime: "node22",
      timeout: requested,
      networkPolicy: "deny-all",
      token: env.VERCEL_TOKEN,
      teamId: env.VERCEL_TEAM_ID,
      projectId: env.VERCEL_PROJECT_ID,
      tags: { purpose: "development-smoke", issue: "144" },
      signal: AbortSignal.timeout(60_000),
    });
    const result = await sandbox.runCommand({ cmd: "node", args: ["-e", "process.stdout.write('sandbox-ok')"] });
    if (result.exitCode !== 0) throw new Error(`real Sandbox smoke command failed (${result.exitCode})`);
    return { ok: true, mode: "real-sandbox-creation", sandbox_id: sandbox.name, timeout_ms: requested };
  } finally {
    if (sandbox) await sandbox.stop({ signal: AbortSignal.timeout(30_000) });
  }
}
