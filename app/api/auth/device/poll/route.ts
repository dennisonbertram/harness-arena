import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AGENT_TOKEN_EXPIRY_SECONDS, mintAgentToken } from "@/lib/agent-token";
import { issueScopedAgentSession } from "@/lib/agent-network-runtime";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";

// A device code is valid for ~15 minutes and GitHub's advertised poll interval
// is 5s, so a patient human legitimately generates ~180 polls for ONE login.
// A 30/hour bucket closed after ~150 seconds and stranded anyone slower than
// that, with no way to finish -- the client cannot distinguish this local 429
// from GitHub's own slow_down, so it just kept polling a dead bucket.
const isRateLimited = createRateLimiter(240);
const PollInputSchema = z.object({ device_code: z.string().min(1) });

function errorResponse(error: string, interval: unknown) {
  if (error === "authorization_pending") return NextResponse.json({ status: "pending" }, { status: 202 });
  if (error === "slow_down") return NextResponse.json({ status: "slow_down", interval: typeof interval === "number" ? interval : null }, { status: 429 });
  if (error === "expired_token") return NextResponse.json({ error: "device code expired" }, { status: 400 });
  if (error === "access_denied") return NextResponse.json({ error: "device authorization denied" }, { status: 400 });
  return NextResponse.json({ error: "GitHub Device Flow is not enabled for this OAuth app. Enable Device Flow in the GitHub OAuth App settings." }, { status: 503 });
}

export async function POST(request: NextRequest) {
  if (isRateLimited(clientIp(request))) return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  const clientId = process.env.AUTH_GITHUB_ID;
  const clientSecret = process.env.AUTH_GITHUB_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "GitHub Device Flow is not configured: set AUTH_GITHUB_ID and AUTH_GITHUB_SECRET on the server" }, { status: 503 });
  }
  const parsed = PollInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid device_code" }, { status: 400 });

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, device_code: parsed.data.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
  });
  const tokenBody = (await tokenResponse.json().catch(() => null)) as Record<string, unknown> | null;
  if (!tokenBody) return NextResponse.json({ error: "GitHub returned an invalid Device Flow response" }, { status: 502 });
  if (typeof tokenBody.error === "string") return errorResponse(tokenBody.error, tokenBody.interval);
  if (!tokenResponse.ok || typeof tokenBody.access_token !== "string") return NextResponse.json({ error: "GitHub returned an invalid Device Flow response" }, { status: 502 });

  const userResponse = await fetch("https://api.github.com/user", {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${tokenBody.access_token}` },
  });
  const user = (await userResponse.json().catch(() => null)) as Record<string, unknown> | null;
  if (!userResponse.ok || !user || typeof user.id !== "number" || typeof user.login !== "string") {
    return NextResponse.json({ error: "GitHub could not verify the authorized user" }, { status: 502 });
  }
  if (process.env.AGENT_NETWORK_ENABLED === "true") {
    try {
      return NextResponse.json(await issueScopedAgentSession({ githubId: user.id, githubLogin: user.login }));
    } catch {
      return NextResponse.json({ error: "agent session service unavailable" }, { status: 503 });
    }
  }
  const token = await mintAgentToken({ githubId: user.id, githubLogin: user.login });
  return NextResponse.json({ token, github_login: user.login, expires_at: new Date(Date.now() + AGENT_TOKEN_EXPIRY_SECONDS * 1000).toISOString() });
}
