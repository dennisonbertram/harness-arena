import { executePassiveMonitorCron } from "@/lib/passive-monitor-cron.mjs";
import { log, type LogLevel } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function levelFor(event: Record<string, unknown>): LogLevel {
  if (event.kind === "monitor_self_failure" || event.verdict === "failed") return "error";
  if (event.verdict === "degraded" || event.verdict === "access_blocked") return "warn";
  return "info";
}

export async function GET(request: Request): Promise<Response> {
  const result = await executePassiveMonitorCron({ request, env: process.env, fetchImpl: globalThis.fetch });
  for (const event of result.events) log(levelFor(event), "monitor.observation", event);
  return Response.json(result.body, { status: result.status });
}
