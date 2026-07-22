import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("returns 200 with ok:true and a sha string", async () => {
    const response = await GET();

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(typeof body.sha).toBe("string");
    expect(body.sha.length).toBeGreaterThan(0);
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
});
