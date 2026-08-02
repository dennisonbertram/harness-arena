import { describe, expect, it, vi } from "vitest";
import { onRequestError } from "./instrumentation";

describe("onRequestError", () => {
  it("awaits structured redacted Error telemetry including a digest", async () => {
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
      error_class: "Error",
      error_digest: "digest-42",
      error_stage: "request",
      request: { method: "POST", path: "/api/runs" },
    });
    expect(line.error_stack.length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(line)).not.toContain("secret");
    expect(JSON.stringify(line)).not.toContain("signed-value");
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
    expect(line).toMatchObject({ error_class: "NonError", error_stage: "request" });
    expect(JSON.stringify(line)).not.toContain("secret");
    spy.mockRestore();
  });
});
