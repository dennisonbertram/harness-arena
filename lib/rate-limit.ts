import type { NextRequest } from "next/server";

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

// ponytail: naive in-memory per-key rate limiter — POC-level, not a real abuse
// boundary. Per-process state, so on serverless (each invocation may be a
// separate instance/cold start) this does not enforce a global limit across
// all traffic to a key. Mirrors the pattern already used in
// app/api/submissions/route.ts, extracted so both competition endpoints
// (admin trigger + submissions, one keyed by IP, one also keyed by agent
// name) can share it instead of duplicating the Map bookkeeping.
export function createRateLimiter(max: number, windowMs: number = DEFAULT_WINDOW_MS) {
  const timestamps = new Map<string, number[]>();
  return function isRateLimited(key: string, now: number = Date.now()): boolean {
    const recent = (timestamps.get(key) ?? []).filter((t) => now - t < windowMs);
    const limited = recent.length >= max;
    if (!limited) recent.push(now);
    timestamps.set(key, recent);
    return limited;
  };
}

export function clientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
