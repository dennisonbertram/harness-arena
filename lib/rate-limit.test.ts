import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { clientIp, createRateLimiter } from "./rate-limit";

function requestWithHeaders(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/api/test", { headers });
}

describe("clientIp", () => {
  it("prefers the platform-provided x-real-ip over a client-controlled x-forwarded-for", () => {
    const request = requestWithHeaders({
      "x-forwarded-for": "9.9.9.9",
      "x-real-ip": "5.5.5.5",
    });
    expect(clientIp(request)).toBe("5.5.5.5");
  });

  it("falls back to the LAST x-forwarded-for entry when x-real-ip is absent", () => {
    // The platform proxy appends the real client IP as the final hop; earlier
    // entries are client-supplied and spoofable.
    const request = requestWithHeaders({
      "x-forwarded-for": "9.9.9.9, 8.8.8.8, 5.5.5.5",
    });
    expect(clientIp(request)).toBe("5.5.5.5");
  });

  it("maps requests with no IP headers onto one stable shared key", () => {
    expect(clientIp(requestWithHeaders({}))).toBe(clientIp(requestWithHeaders({})));
  });
});

describe("createRateLimiter", () => {
  it("a spoofed x-forwarded-for cannot escape the bucket the platform-derived IP maps to", () => {
    const isLimited = createRateLimiter(1);

    const realRequest = () =>
      clientIp(
        requestWithHeaders({
          "x-real-ip": "5.5.5.5",
          "x-forwarded-for": "5.5.5.5",
        }),
      );

    expect(isLimited(realRequest())).toBe(false);
    expect(isLimited(realRequest())).toBe(true);

    // Attacker rotates a fresh spoofed XFF value per request; the platform
    // x-real-ip (and the appended-last-hop fallback) keeps them in the same
    // exhausted bucket.
    for (let i = 0; i < 5; i++) {
      const spoofed = clientIp(
        requestWithHeaders({
          "x-real-ip": "5.5.5.5",
          "x-forwarded-for": `9.9.9.${i}, 5.5.5.5`,
        }),
      );
      expect(isLimited(spoofed)).toBe(true);
    }
  });

  it("requests with no IP headers share one conservative bucket", () => {
    const isLimited = createRateLimiter(1);
    expect(isLimited(clientIp(requestWithHeaders({})))).toBe(false);
    expect(isLimited(clientIp(requestWithHeaders({})))).toBe(true);
  });

  it("prunes expired keys so unique IPs do not grow the map unbounded", () => {
    const isLimited = createRateLimiter(1, 1000, /* sweepThreshold */ 10);

    for (let i = 0; i < 100; i++) {
      isLimited(`10.0.0.${i}`, 1000);
    }
    expect(isLimited.size()).toBeGreaterThanOrEqual(10);

    // Past the window AND past the sweep threshold: the next call sweeps the
    // stale entries instead of accumulating them forever.
    isLimited("10.0.0.0", 5000);
    expect(isLimited.size()).toBeLessThan(10);
  });
});
