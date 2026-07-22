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

  it("surfaces judge_reason as the error for a rejected JSON response", async () => {
    const response = fakeResponse(422, false, async () => ({
      submission_id: "s2",
      status: "rejected",
      judge_reason: "prompt too long",
    }));
    const parsed = await parseSubmitResponse(response);
    expect(parsed.error).toBe("prompt too long");
  });

  it("falls back to 'HTTP <status>' when a non-OK response body isn't JSON", async () => {
    const response = fakeResponse(502, false, async () => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    });
    const parsed = await parseSubmitResponse(response);
    expect(parsed.error).toBe("HTTP 502");
    expect(parsed.result).toBeNull();
  });

  it("falls back to 'HTTP <status>' when an OK response body isn't JSON", async () => {
    const response = fakeResponse(200, true, async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    });
    const parsed = await parseSubmitResponse(response);
    expect(parsed.error).toBe("HTTP 200");
    expect(parsed.result).toBeNull();
  });
});
