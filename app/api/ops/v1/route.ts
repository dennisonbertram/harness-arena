import { NextRequest, NextResponse } from "next/server";
import { OPS_RECORD_KINDS, OPS_SCHEMA_VERSION, opsAuthorized } from "@/lib/ops-read";
import { opsEvent } from "@/lib/ops-route";
export { POST, PUT, PATCH, DELETE, OPTIONS } from "@/lib/ops-route";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const response = !opsAuthorized(request.headers.get("authorization"))
    ? NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } })
    : NextResponse.json({ schema_version: OPS_SCHEMA_VERSION, kinds: OPS_RECORD_KINDS, limits:{max_page:100,max_content_bytes:750000,max_summary_records:1000}, inventory: "/api/ops/v1/inventory", read: "/api/ops/v1/read", summary: "/api/ops/v1/summary" }, { headers: { "cache-control": "no-store" } });
  opsEvent(request, response.status);
  return response;
}
