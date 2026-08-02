import { NextRequest, NextResponse } from "next/server";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";

const isRateLimited = createRateLimiter(10);

export async function POST(request: NextRequest) {
  if (isRateLimited(clientIp(request))) return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  const clientId = process.env.AUTH_GITHUB_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "GitHub Device Flow is not configured: set AUTH_GITHUB_ID on the server" },
      { status: 503 },
    );
  }

  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: "read:user" }),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !body || typeof body.error === "string") {
    return NextResponse.json(
      { error: "GitHub Device Flow is not enabled for this OAuth app. Enable Device Flow in the GitHub OAuth App settings." },
      { status: 503 },
    );
  }
  const { device_code, user_code, verification_uri, expires_in, interval } = body;
  if (
    typeof device_code !== "string" || typeof user_code !== "string" || typeof verification_uri !== "string" ||
    typeof expires_in !== "number" || typeof interval !== "number"
  ) {
    return NextResponse.json({ error: "GitHub returned an invalid Device Flow response" }, { status: 502 });
  }
  return NextResponse.json({ device_code, user_code, verification_uri, expires_in, interval });
}
