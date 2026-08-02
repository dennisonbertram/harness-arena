import { describe, expect, it } from "vitest";
import { ToolError } from "./client.js";
import { toToolError } from "./server.js";

describe("MCP error.v1 envelope", () => {
  it("returns the exact structured, redacted error.v1 shape for every known and unknown failure", () => {
    for (const failure of [
      new ToolError("Not authenticated; run the login tool first."),
      new Error("postgres://user:secret@host/arena and 0xprivate"),
      { code: "untrusted", token: "never-return-this" },
    ]) {
      const result = toToolError(failure);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: expect.objectContaining({
          schema_version: "error.v1",
          code: expect.any(String),
          message: expect.any(String),
          retryable: expect.any(Boolean),
        }),
      });
      const error = (result.structuredContent.error as Record<string, unknown>);
      expect(Object.keys(error).sort()).toEqual(expect.arrayContaining(["schema_version", "code", "message", "retryable"]));
      expect(error).not.toHaveProperty("token");
      expect(JSON.stringify(result)).not.toMatch(/postgres:|secret|0xprivate|never-return-this/i);
    }
  });

  it("keeps optional retry and correlation metadata exact when supplied by a stable error", () => {
    const result = toToolError(Object.assign(new ToolError("Temporarily unavailable."), {
      code: "feature_unavailable", retryable: true, retry_after_ms: 30_000, correlation_id: "corr-123",
    }));
    expect(result.structuredContent).toEqual({
      error: {
        schema_version: "error.v1",
        code: "feature_unavailable",
        message: "Temporarily unavailable.",
        retryable: true,
        retry_after_ms: 30_000,
        correlation_id: "corr-123",
      },
    });
  });
});
