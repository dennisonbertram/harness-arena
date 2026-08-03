import { NextRequest, NextResponse } from "next/server";
import { createOpsReadService, OPS_SCHEMA_VERSION, opsAuthorized } from "@/lib/ops-read";
import { observeOpsGet } from "@/lib/ops-route";
export { POST, PUT, PATCH, DELETE, OPTIONS } from "@/lib/ops-route";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  return observeOpsGet(request, async () => {
    const headers = { "cache-control": "no-store" };
    if (!opsAuthorized(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
    return NextResponse.json({ schema_version: OPS_SCHEMA_VERSION, ...await createOpsReadService().summary() }, { headers });
  });
}
