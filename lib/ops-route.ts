import { NextResponse } from "next/server";
import { log, normalizeError } from "@/lib/log";
export const OPS_HEADERS = { "cache-control": "no-store" };
function requestFields(request: Request | undefined, status: number) {
  let route = "/api/ops/v1";
  let method = "UNKNOWN";
  try { if (request) route = new URL(request.url).pathname; } catch { /* keep constant fallback */ }
  try { if (request && typeof request.method === "string") method = request.method; } catch { /* keep constant fallback */ }
  return { route, method, status };
}
export function opsEvent(request: Request | undefined, status: number): void {
  const controlled = status >= 400;
  log(controlled ? "warn" : "info", controlled ? "ops.request.controlled_failure" : "ops.request.succeeded", {
    ...requestFields(request, status),
  });
}
export async function observeOpsGet<T extends Response>(request: Request, handler: () => Promise<T> | T): Promise<T> {
  try {
    const response = await handler();
    opsEvent(request, response.status);
    return response;
  } catch (error) {
    log("error", "ops.request.unexpected_failure", {
      ...requestFields(request, 500),
      ...normalizeError(error, "ops_read"),
    });
    throw error;
  }
}
export const methodNotAllowed = (request?: Request) => {
  opsEvent(request, 405);
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405, headers: { ...OPS_HEADERS, allow: "GET" } });
};
export const POST=methodNotAllowed,PUT=methodNotAllowed,PATCH=methodNotAllowed,DELETE=methodNotAllowed,OPTIONS=methodNotAllowed;
