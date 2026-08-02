import { describe, expect, it, vi } from "vitest";
import { onRequestError } from "./instrumentation";

describe("onRequestError", () => {
  it("awaits structured redacted Error telemetry including a digest", async () => {
    const flushed = vi.fn();
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
    expect(flushed).not.toHaveBeenCalled();
    expect(error.digest).toBe("digest-42");
  });

  it("records non-Error throws without leaking request data", async () => {
    await expect(onRequestError("bad callback payload", {
      path: "/api/runs/r1/callback?signature=secret",
      method: "POST",
      headers: { cookie: "secret" },
    }, { routerKind: "App Router", routePath: "/api/runs/[id]/callback", routeType: "route" } as never)).resolves.toBeUndefined();
  });
});
