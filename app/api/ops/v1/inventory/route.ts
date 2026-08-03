import { NextRequest, NextResponse } from "next/server";
import { createOpsReadService, OPS_RECORD_KINDS, OPS_SCHEMA_VERSION, opsAuthorized, type OpsKind } from "@/lib/ops-read";
import { observeOpsGet } from "@/lib/ops-route";
export { POST, PUT, PATCH, DELETE, OPTIONS } from "@/lib/ops-route";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  return observeOpsGet(request, async () => {
    const headers = { "cache-control": "no-store" };
    if (!opsAuthorized(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
    const kind = request.nextUrl.searchParams.get("kind") as OpsKind;
    if (!OPS_RECORD_KINDS.some((entry) => entry.kind === kind)) return NextResponse.json({ error: "unknown_kind" }, { status: 400, headers });
    const result = await createOpsReadService().list(kind, {
      limit: Number(request.nextUrl.searchParams.get("limit") ?? 50),
      cursor: request.nextUrl.searchParams.get("cursor") ?? undefined,
      run_id: request.nextUrl.searchParams.get("run_id") ?? undefined,
    });
    const code = result.error?.code;
    return NextResponse.json({ schema_version: OPS_SCHEMA_VERSION, kind, ...result }, {
      status: ["partial_read", "cursor_secret_missing", "page_item_limit"].includes(code ?? "") ? 503 : code ? 400 : 200,
      headers,
    });
  });
}
