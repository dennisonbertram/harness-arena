import { afterEach, describe, expect, it, vi } from "vitest";
import { submitBaseline } from "./submit-baseline.mjs";

describe("scripts/submit-baseline.mjs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not make any network calls on import (only via --confirm CLI invocation)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // Re-importing an already-loaded ES module returns the cached module
    // without re-executing top-level code, so this asserts the guard: the
    // module's top-level scope never calls fetch on its own.
    await import("./submit-baseline.mjs");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches the baseline prompt and POSTs it as pi-vanilla-baseline", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "vanilla prompt text",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ submission_id: "sub-1", run_id: "run-1", status: "queued" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitBaseline("https://example.test");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://example.test/api/baseline-prompt");

    const [submitUrl, submitOptions] = fetchMock.mock.calls[1];
    expect(submitUrl).toBe("https://example.test/api/submissions");
    expect(submitOptions.method).toBe("POST");
    expect(submitOptions.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(submitOptions.body)).toEqual({
      agent_name: "pi-vanilla-baseline",
      prompt: "vanilla prompt text",
    });

    expect(result).toEqual({
      status: 200,
      body: { submission_id: "sub-1", run_id: "run-1", status: "queued" },
    });
  });

  it("throws if GET /api/baseline-prompt fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }),
    );

    await expect(submitBaseline("https://example.test")).rejects.toThrow(
      "GET /api/baseline-prompt failed: 500",
    );
  });

  it("throws on a non-2xx POST /api/submissions instead of reporting success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => "vanilla prompt text" })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: "judge unavailable, retry later" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitBaseline("https://example.test")).rejects.toThrow(
      "POST /api/submissions failed: HTTP 503",
    );
  });
});
