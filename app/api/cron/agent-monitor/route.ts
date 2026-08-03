import { executePassiveMonitorCron } from "@/lib/passive-monitor-cron.mjs";
import { log, type LogLevel } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

function levelFor(event: Record<string, unknown>): LogLevel {
  if (event.kind === "monitor_self_failure" || event.verdict === "failed") return "error";
  if (event.verdict === "degraded" || event.verdict === "access_blocked") return "warn";
  return "info";
}

export async function GET(request: Request): Promise<Response> {
  const result = await executePassiveMonitorCron({
    request,
    env: {
      CRON_SECRET: process.env.CRON_SECRET,
      DEVELOPMENT_OPS_READ_TOKEN: process.env.DEVELOPMENT_OPS_READ_TOKEN,
      PRODUCTION_OPS_READ_TOKEN: process.env.PRODUCTION_OPS_READ_TOKEN,
      VERCEL_READ_TOKEN: process.env.VERCEL_READ_TOKEN,
      VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID,
      VERCEL_ENV: process.env.VERCEL_ENV,
    },
    fetchImpl: globalThis.fetch,
  });
  let retained = true;
  for (const event of result.events) {
    const {
      environment: target_environment,
      deployment_sha: target_deployment_sha,
      ...fields
    } = event;
    retained = log(levelFor(event), "monitor.observation", {
      ...fields,
      target_environment,
      target_deployment_sha,
    }) && retained;
  }
  if (!retained) return Response.json({ ok: false, error: "observation_not_retained" }, { status: 503 });
  return Response.json(result.body, { status: result.status });
}
