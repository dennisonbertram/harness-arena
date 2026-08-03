import { registerOTel } from "@vercel/otel";
import type { Instrumentation } from "next";
import { log, normalizeError } from "./lib/log";

type MutableSpanAttributes = { attributes?: Record<string, unknown> };

const SAFE_REQUEST_ATTRIBUTES = new Set(["http.request.method", "http.response.status_code"]);
const SENSITIVE_SPAN_ATTRIBUTE = /(?:url|query|request|http\.target|http\.route)/i;

/** Removes request-derived attributes before any configured exporter receives a span. */
export function createSpanAttributeSanitizer() {
  const sanitize = (span: MutableSpanAttributes) => {
    for (const key of Object.keys(span.attributes ?? {})) {
      if (SENSITIVE_SPAN_ATTRIBUTE.test(key) && !SAFE_REQUEST_ATTRIBUTES.has(key)) delete span.attributes?.[key];
    }
  };
  return {
    onStart(span: MutableSpanAttributes) { sanitize(span); },
    onEnding(span: MutableSpanAttributes) { sanitize(span); },
    onEnd() {},
    forceFlush: async () => {},
    shutdown: async () => {},
  };
}

export function register() {
  registerOTel({
    serviceName: "harness-arena",
    // The sanitizer must precede automatic export processors so URL/query
    // attributes added by instrumentations are removed at span completion.
    spanProcessors: [createSpanAttributeSanitizer() as never, "auto"],
  });
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  // Deliberately omit headers/body. log() strips path query strings.
  log("error", "request.error", {
    ...normalizeError(error, "request"),
    request: { method: request.method, path: request.path },
    route: { router_kind: context.routerKind, route_path: context.routePath, route_type: context.routeType },
  });
};
