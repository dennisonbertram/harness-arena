import { describe, expect, it, vi } from "vitest";
import { createSpanAttributeSanitizer, onRequestError } from "./instrumentation";

describe("onRequestError", () => {
  it("awaits structured safe Error telemetry without raw error text or stack", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = Object.assign(new Error("gateway timeout"), { digest: "digest-42" });
    await onRequestError(error, {
      path: "/api/runs?token=signed-value",
      method: "POST",
      headers: { authorization: "Bearer secret", cookie: "session=secret" },
    }, {
      routerKind: "App Router",
      routePath: "/api/runs",
      routeType: "route",
    } as never);
    const line = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(line).toMatchObject({
      event: "request.error",
      error_schema: "v1",
      error_class: "error",
      error_fingerprint: expect.stringMatching(/^fnv1a-[0-9a-f]{8}$/),
      error_stage: "request",
      request: { method: "POST", path: "/api/runs" },
    });
    for (const forbidden of ["gateway timeout", "digest-42", "secret", "signed-value", "error_stack", "error_message"]) expect(JSON.stringify(line)).not.toContain(forbidden);
    spy.mockRestore();
  });

  it("records non-Error throws without leaking request data", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(onRequestError("bad callback payload", {
      path: "/api/runs/r1/callback?signature=secret",
      method: "POST",
      headers: { cookie: "secret" },
    }, { routerKind: "App Router", routePath: "/api/runs/[id]/callback", routeType: "route" } as never)).resolves.toBeUndefined();
    const line = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(line).toMatchObject({ error_schema: "v1", error_class: "non_error", error_stage: "request" });
    expect(JSON.stringify(line)).not.toContain("secret");
    spy.mockRestore();
  });

  it("drops every URL, query, and request attribute except the safe HTTP method", () => {
    const sanitizer = createSpanAttributeSanitizer();
    const span = { attributes: {
      "url.full": "https://arena.example/api/runs?token=secret",
      "http.target": "/api/runs?signature=secret",
      "http.request.header.authorization": "Bearer secret",
      "http.request.method": "POST",
      "http.response.status_code": 503,
      "server.address": "arena.example",
      "custom.attribute": "safe",
    } };
    sanitizer.onStart(span as never, {} as never);
    sanitizer.onEnding?.(span as never);
    expect(span.attributes).toEqual({
      "http.request.method": "POST",
      "http.response.status_code": 503,
      "server.address": "arena.example",
      "custom.attribute": "safe",
    });
  });
});
