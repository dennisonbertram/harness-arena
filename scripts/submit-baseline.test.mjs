import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

// Keep this script test suite isolated from the real Blob client used by the
// other operational scripts. submit-baseline currently talks only to its HTTP
// endpoints, but no test should be able to initialize a live Blob client.
vi.mock("@vercel/blob", () => ({
  del: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  put: vi.fn(),
}));

import { submitBaseline } from "./submit-baseline.mjs";

describe("scripts/submit-baseline.mjs", () => {
  const scriptPath = fileURLToPath(new URL("./submit-baseline.mjs", import.meta.url));
  let originalArgv;

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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

  it("uses BASE when no explicit base is supplied", async () => {
    vi.stubEnv("BASE", "https://configured.example");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => "configured prompt" })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ status: "queued" }) });
    vi.stubGlobal("fetch", fetchMock);

    await submitBaseline();

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://configured.example/api/baseline-prompt");
  });

  it("returns a rejected 2xx submission response to the caller", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, text: async () => "vanilla prompt text" })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ status: "rejected", reason: "duplicate baseline" }),
        }),
    );

    await expect(submitBaseline("https://example.test")).resolves.toEqual({
      status: 200,
      body: { status: "rejected", reason: "duplicate baseline" },
    });
  });

  it("returns a null body when a successful POST has no JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, text: async () => "vanilla prompt text" })
        .mockResolvedValueOnce({
          ok: true,
          status: 204,
          json: async () => {
            throw new SyntaxError("Unexpected end of JSON input");
          },
        }),
    );

    await expect(submitBaseline("https://example.test")).resolves.toEqual({ status: 204, body: null });
  });

  it("reports a non-2xx POST with no JSON body without an empty detail suffix", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, text: async () => "vanilla prompt text" })
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          json: async () => {
            throw new SyntaxError("not JSON");
          },
        }),
    );

    await expect(submitBaseline("https://example.test")).rejects.toThrow(
      "POST /api/submissions failed: HTTP 429",
    );
  });

  it("refuses a direct CLI invocation without --confirm before making a request", async () => {
    process.argv = [process.argv[0], scriptPath];
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();

    await expect(import("./submit-baseline.mjs")).rejects.toThrow("process.exit called");

    expect(error).toHaveBeenCalledWith("Refusing to submit without --confirm (see scripts/submit-baseline.mjs).");
    expect(exit).toHaveBeenCalledWith(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits and reports the result for a confirmed direct CLI invocation", async () => {
    process.argv = [process.argv[0], scriptPath, "--confirm"];
    vi.stubEnv("BASE", "https://cli.example");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => "CLI prompt" })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ status: "queued" }) });
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.resetModules();

    await import("./submit-baseline.mjs");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://cli.example/api/baseline-prompt");
    expect(log).toHaveBeenNthCalledWith(1, "Submitting pi-vanilla-baseline baseline to https://cli.example ...");
    expect(log).toHaveBeenNthCalledWith(2, "HTTP 201");
    expect(log).toHaveBeenNthCalledWith(3, '{\n  "status": "queued"\n}');
  });
});
