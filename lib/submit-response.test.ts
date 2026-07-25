import { describe, expect, it } from "vitest";
import { parseSubmitResponse, type MinimalFetchResponse } from "./submit-response";

function fakeResponse(status: number, ok: boolean, jsonImpl: () => Promise<unknown>): MinimalFetchResponse {
  return { ok, status, json: jsonImpl };
}

describe("parseSubmitResponse", () => {
  it("returns the parsed body and no error for a 200 JSON response", async () => {
    const response = fakeResponse(200, true, async () => ({ submission_id: "s1", status: "queued" }));
    const parsed = await parseSubmitResponse(response);
    expect(parsed.error).toBeNull();
    expect(parsed.result).toEqual({ submission_id: "s1", status: "queued" });
  });

  it("surfaces judge_reason as the error and flags rejected for a rejected verdict (200 + status rejected)", async () => {
    const response = fakeResponse(200, true, async () => ({
      submission_id: "s2",
      status: "rejected",
      judge_reason: "Hardcodes a task answer.",
    }));
    const parsed = await parseSubmitResponse(response);
    expect(parsed.error).toBe("Hardcodes a task answer.");
    expect(parsed.rejected).toBe(true);
  });

  it("surfaces the server's error message (not a bare HTTP code) for an infra failure, and does NOT flag it rejected", async () => {
    const response = fakeResponse(503, false, async () => ({ error: "The fairness judge was temporarily unavailable." }));
    const parsed = await parseSubmitResponse(response);
    expect(parsed.error).toBe("The fairness judge was temporarily unavailable.");
    expect(parsed.rejected).toBe(false);
  });

  it("falls back to a readable HTTP message when a non-OK response body isn't JSON", async () => {
    const response = fakeResponse(502, false, async () => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    });
    const parsed = await parseSubmitResponse(response);
    expect(parsed.error).toBe("The server returned HTTP 502.");
    expect(parsed.result).toBeNull();
  });

  it("falls back to a readable HTTP message when an OK response body isn't JSON", async () => {
    const response = fakeResponse(200, true, async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    });
    const parsed = await parseSubmitResponse(response);
    expect(parsed.error).toBe("The server returned HTTP 200.");
    expect(parsed.result).toBeNull();
  });

  it("regression: degrades gracefully even when the body read fails with a non-SyntaxError (e.g. an aborted stream)", () => {
    const response = fakeResponse(503, false, async () => {
      throw new TypeError("terminated");
    });
    return expect(parseSubmitResponse(response)).resolves.toEqual({
      result: null,
      error: "The server returned HTTP 503.",
      rejected: false,
      sessionExpired: false,
    });
  });

  it("flags sessionExpired (not rejected) for a 401", async () => {
    const response = fakeResponse(401, false, async () => ({ error: "sign in with GitHub to submit" }));
    const parsed = await parseSubmitResponse(response);
    expect(parsed.sessionExpired).toBe(true);
    expect(parsed.rejected).toBe(false);
    expect(parsed.error).toBe("sign in with GitHub to submit");
  });

  it("does not flag sessionExpired for a non-401 infra failure", async () => {
    const response = fakeResponse(503, false, async () => ({ error: "unavailable" }));
    const parsed = await parseSubmitResponse(response);
    expect(parsed.sessionExpired).toBe(false);
  });
});
