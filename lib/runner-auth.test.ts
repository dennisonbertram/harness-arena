import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyRunnerSecret } from "./runner-auth";

const SECRET = "test-runner-secret";

function requestWithSecretHeader(header: string | null): NextRequest {
  const headers: Record<string, string> = {};
  if (header !== null) headers["x-runner-secret"] = header;
  return new NextRequest("http://localhost/api/runs/run-1/callback", { method: "POST", headers });
}

describe("verifyRunnerSecret", () => {
  const originalSecret = process.env.RUNNER_CALLBACK_SECRET;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.RUNNER_CALLBACK_SECRET;
    else process.env.RUNNER_CALLBACK_SECRET = originalSecret;
    vi.restoreAllMocks();
  });

  it("returns false when RUNNER_CALLBACK_SECRET is unset, even with an empty header", () => {
    delete process.env.RUNNER_CALLBACK_SECRET;

    expect(verifyRunnerSecret(requestWithSecretHeader(""))).toBe(false);
  });

  it("logs runner_secret.unconfigured when RUNNER_CALLBACK_SECRET is unset", () => {
    delete process.env.RUNNER_CALLBACK_SECRET;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    verifyRunnerSecret(requestWithSecretHeader(null));

    const logged = logSpy.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(logged.some((entry) => entry.level === "error" && entry.event === "runner_secret.unconfigured")).toBe(
      true,
    );
  });

  it("returns false when RUNNER_CALLBACK_SECRET is an empty string, even with an empty header", () => {
    process.env.RUNNER_CALLBACK_SECRET = "";

    expect(verifyRunnerSecret(requestWithSecretHeader(""))).toBe(false);
  });

  it("returns false when the header does not match the configured secret", () => {
    process.env.RUNNER_CALLBACK_SECRET = SECRET;

    expect(verifyRunnerSecret(requestWithSecretHeader("wrong-secret"))).toBe(false);
  });

  it("returns true when the header matches the configured secret exactly", () => {
    process.env.RUNNER_CALLBACK_SECRET = SECRET;

    expect(verifyRunnerSecret(requestWithSecretHeader(SECRET))).toBe(true);
  });

  describe("regression: no header present at all must not throw and must deny", () => {
    it("returns false (not a thrown TypeError) when the header is missing entirely", () => {
      process.env.RUNNER_CALLBACK_SECRET = SECRET;

      expect(() => verifyRunnerSecret(requestWithSecretHeader(null))).not.toThrow();
      expect(verifyRunnerSecret(requestWithSecretHeader(null))).toBe(false);
    });
  });
});
