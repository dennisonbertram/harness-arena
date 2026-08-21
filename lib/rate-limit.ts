import type { NextRequest } from "next/server";

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

// Sweep the key map once it grows past this many entries, dropping expired
// windows so unique keys (e.g. per-IP buckets) cannot accumulate forever on a
// long-lived instance.
const DEFAULT_SWEEP_THRESHOLD = 10_000;

// ponytail: naive in-memory per-key rate limiter — POC-level, not a real abuse
// boundary. Per-process state, so on serverless (each invocation may be a
// separate instance/cold start) this does not enforce a global limit across
// all traffic to a key. Mirrors the pattern already used in
// app/api/submissions/route.ts, extracted so both competition endpoints
// (admin trigger + submissions, one keyed by IP, one also keyed by agent
// name) can share it instead of duplicating the Map bookkeeping.
export function createRateLimiter(
  max: number,
  windowMs: number = DEFAULT_WINDOW_MS,
  sweepThreshold: number = DEFAULT_SWEEP_THRESHOLD,
) {
  const timestamps = new Map<string, number[]>();

  function sweep(now: number) {
    for (const [key, times] of timestamps) {
      const recent = times.filter((t) => now - t < windowMs);
      if (recent.length === 0) timestamps.delete(key);
      else if (recent.length !== times.length) timestamps.set(key, recent);
    }
  }

  const isRateLimited = function (key: string, now: number = Date.now()): boolean {
    if (timestamps.size > sweepThreshold) sweep(now);
    const recent = (timestamps.get(key) ?? []).filter((t) => now - t < windowMs);
    const limited = recent.length >= max;
    if (!limited) recent.push(now);
    if (recent.length === 0) timestamps.delete(key);
    else timestamps.set(key, recent);
    return limited;
  };

  // Test/ops hook: current number of tracked keys.
  isRateLimited.size = () => timestamps.size;

  return isRateLimited;
}

// The first x-forwarded-for entry is client-controlled wherever requests
// arrive without Vercel's edge normalization, so trusting it lets attackers
// rotate the header to get fresh buckets. Prefer the platform-set x-real-ip,
// then the LAST x-forwarded-for hop (appended by the trusted proxy), and fall
// back to one shared conservative bucket when no IP is derivable.
export function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ||
    "ip-unavailable"
  );
}
