import { registerOTel } from "@vercel/otel";
import type { Instrumentation } from "next";
import { log, normalizeError } from "./lib/log";

export function register() {
  registerOTel({ serviceName: "harness-arena" });
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  // Deliberately omit headers/body. log() strips path query strings.
  log("error", "request.error", {
    ...normalizeError(error, "request"),
    request: { method: request.method, path: request.path },
    route: { router_kind: context.routerKind, route_path: context.routePath, route_type: context.routeType },
  });
};
