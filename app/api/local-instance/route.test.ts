import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

const originalEnv = { ...process.env };

function request(nonce?: string) {
  return new NextRequest("http://127.0.0.1/api/local-instance", {
    headers: nonce ? { "x-harness-local-instance-nonce": nonce } : undefined,
  });
}

describe("GET /api/local-instance", () => {
  beforeEach(() => {
    vi.stubEnv("HARNESS_LOCAL_INIT", "1");
    vi.stubEnv("STORAGE", "file");
    vi.stubEnv("LOCAL_INSTANCE_NONCE", "expected-local-nonce");
    vi.stubEnv("LOCAL_INSTANCE_PID", "4242");
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...originalEnv };
  });

  it("returns only an empty 204 for an exact local nonce without echoing identity", async () => {
    const response = await GET(request("expected-local-nonce"));
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect([...response.headers]).not.toEqual(expect.arrayContaining([
      expect.arrayContaining([expect.any(String), expect.stringContaining("expected-local-nonce")]),
    ]));
  });

  it.each([undefined, "", "wrong-local-nonce"])("fails closed for a missing or wrong nonce (%s)", async (nonce) => {
    const response = await GET(request(nonce));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it.each([
    ["production NODE_ENV", { NODE_ENV: "production" }],
    ["Vercel runtime", { VERCEL: "1" }],
    ["Vercel environment", { VERCEL_ENV: "production" }],
    ["Vercel hostname", { VERCEL_URL: "public.example" }],
    ["non-file storage", { STORAGE: "blob" }],
    ["non-init process", { HARNESS_LOCAL_INIT: "0" }],
  ])("cannot become a public diagnostic in %s", async (_label, overrides) => {
    Object.assign(process.env, overrides);
    const response = await GET(request("expected-local-nonce"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("rejects a non-loopback request even when local environment flags are forged", async () => {
    const response = await GET(new NextRequest("https://public.example/api/local-instance", {
      headers: { "x-harness-local-instance-nonce": "expected-local-nonce" },
    }));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});
