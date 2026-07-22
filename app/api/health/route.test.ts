import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

import { GET } from "./route";

describe("GET /api/health", () => {
  beforeEach(() => {
    resetStorage();
  });

  it("returns 200 with ok:true and a sha string", async () => {
    const response = await GET();

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(typeof body.sha).toBe("string");
    expect(body.sha.length).toBeGreaterThan(0);
  });

  it("reports storage: 'up' when storage is reachable", async () => {
    const response = await GET();
    const body = await response.json();

    expect(body.storage).toBe("up");
  });

  it("reports storage: 'down' when storage.listRuns() throws, instead of crashing the endpoint", async () => {
    storageRef.current.listRuns = vi.fn().mockRejectedValue(new Error("storage unreachable"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.storage).toBe("down");
  });

  describe("gateway_key_present / runner_secret_present", () => {
    const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;
    const originalRunnerSecret = process.env.RUNNER_CALLBACK_SECRET;

    afterEach(() => {
      if (originalGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = originalGatewayKey;
      if (originalRunnerSecret === undefined) delete process.env.RUNNER_CALLBACK_SECRET;
      else process.env.RUNNER_CALLBACK_SECRET = originalRunnerSecret;
    });

    it("reports gateway_key_present:false and runner_secret_present:false when both env vars are unset", async () => {
      delete process.env.AI_GATEWAY_API_KEY;
      delete process.env.RUNNER_CALLBACK_SECRET;

      const response = await GET();
      const body = await response.json();

      expect(body.gateway_key_present).toBe(false);
      expect(body.runner_secret_present).toBe(false);
    });

    it("reports gateway_key_present:true and runner_secret_present:true when both env vars are set, without leaking their values", async () => {
      process.env.AI_GATEWAY_API_KEY = "super-secret-gateway-key";
      process.env.RUNNER_CALLBACK_SECRET = "super-secret-runner-secret";

      const response = await GET();
      const body = await response.json();

      expect(body.gateway_key_present).toBe(true);
      expect(body.runner_secret_present).toBe(true);
      const rawJson = JSON.stringify(body);
      expect(rawJson).not.toContain("super-secret-gateway-key");
      expect(rawJson).not.toContain("super-secret-runner-secret");
    });
  });

  describe("regression: sha source precedence", () => {
    const originalSha = process.env.VERCEL_GIT_COMMIT_SHA;

    afterEach(() => {
      if (originalSha === undefined) {
        delete process.env.VERCEL_GIT_COMMIT_SHA;
      } else {
        process.env.VERCEL_GIT_COMMIT_SHA = originalSha;
      }
    });

    it("uses VERCEL_GIT_COMMIT_SHA verbatim when set, instead of the local git sha", async () => {
      process.env.VERCEL_GIT_COMMIT_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

      const response = await GET();
      const body = await response.json();

      expect(body.sha).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    });
  });

  describe("regression: ok/sha stay present and unchanged regardless of the new checks' results", () => {
    it("keeps ok:true and a non-empty sha even when storage is down, so ticket #1 consumers reading only {ok, sha} never break", async () => {
      storageRef.current.listRuns = vi.fn().mockRejectedValue(new Error("storage unreachable"));

      const response = await GET();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(typeof body.sha).toBe("string");
      expect(body.sha.length).toBeGreaterThan(0);
      // ...and the new field is present alongside them, not replacing them.
      expect(body.storage).toBe("down");
    });
  });
});
