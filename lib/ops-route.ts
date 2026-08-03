import { NextResponse } from "next/server";
export const OPS_HEADERS = { "cache-control": "no-store" };
export const methodNotAllowed = () => NextResponse.json({ error: "method_not_allowed" }, { status: 405, headers: { ...OPS_HEADERS, allow: "GET" } });
export const POST=methodNotAllowed,PUT=methodNotAllowed,PATCH=methodNotAllowed,DELETE=methodNotAllowed,OPTIONS=methodNotAllowed;
