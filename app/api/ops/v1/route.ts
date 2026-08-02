import { NextRequest, NextResponse } from "next/server";
import { OPS_RECORD_KINDS, OPS_SCHEMA_VERSION, opsAuthorized } from "@/lib/ops-read";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) { if (request.method !== "GET") return NextResponse.json({ error: "method_not_allowed" }, { status: 405, headers: { "cache-control": "no-store" } }); if (!opsAuthorized(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } }); return NextResponse.json({ schema_version: OPS_SCHEMA_VERSION, kinds: OPS_RECORD_KINDS, inventory: "/api/ops/v1/inventory", read: "/api/ops/v1/read", summary: "/api/ops/v1/summary" }, { headers: { "cache-control": "no-store" } }); }
