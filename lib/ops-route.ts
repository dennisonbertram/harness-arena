import { NextResponse } from "next/server";
import { log } from "@/lib/log";
export const OPS_HEADERS = { "cache-control": "no-store" };
export function opsEvent(request: Request | undefined, status: number): void {
  let route = "/api/ops/v1";
  try { if (request) route = new URL(request.url).pathname; } catch { /* keep constant fallback */ }
  const controlled = status >= 400 && status < 500;
  log(controlled ? "warn" : "info", controlled ? "ops.request.controlled_failure" : "ops.request.succeeded", {
    route, method: request?.method ?? "UNKNOWN", status,
  });
}
export const methodNotAllowed = (request?: Request) => {
  opsEvent(request, 405);
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405, headers: { ...OPS_HEADERS, allow: "GET" } });
};
export const POST=methodNotAllowed,PUT=methodNotAllowed,PATCH=methodNotAllowed,DELETE=methodNotAllowed,OPTIONS=methodNotAllowed;
