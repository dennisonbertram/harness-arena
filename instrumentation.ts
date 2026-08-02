import { registerOTel } from "@vercel/otel";
import type { Instrumentation } from "next";
import { log } from "./lib/log";

export function register() {
  registerOTel({ serviceName: "harness-arena" });
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const digest = typeof error === "object" && error !== null && "digest" in error
    ? String(error.digest) : undefined;
  // Deliberately omit headers/body. log() strips path query strings.
  log("error", "request.error", {
    error,
    error_digest: digest,
    request: { method: request.method, path: request.path },
    route: { router_kind: context.routerKind, route_path: context.routePath, route_type: context.routeType },
  });
};
