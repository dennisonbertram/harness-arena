import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };

function hidden() {
  return new NextResponse(null, { status: 404, headers });
}

/** Local ownership handshake only. It never opens storage or returns identity. */
export async function GET(request: NextRequest) {
  const expected = process.env.LOCAL_INSTANCE_NONCE;
  const provided = request.headers.get("x-harness-local-instance-nonce");
  const host = request.nextUrl.hostname;
  const localRuntime = process.env.HARNESS_LOCAL_INIT === "1"
    && process.env.STORAGE === "file"
    && process.env.NODE_ENV === "development"
    && process.env.VERCEL === undefined
    && process.env.VERCEL_ENV === undefined
    && process.env.VERCEL_URL === undefined
    && (host === "127.0.0.1" || host === "localhost");
  if (!localRuntime || !expected || !provided) return hidden();
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  if (expectedBytes.length !== providedBytes.length || !timingSafeEqual(expectedBytes, providedBytes)) return hidden();
  return new NextResponse(null, { status: 204, headers });
}
