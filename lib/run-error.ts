import { PUBLIC_RUN_EVENT_FIELDS } from "./public-run-event-fields.mjs";
import { PUBLIC_GATEWAY_PREFLIGHT_FAILURE_CLASSES } from "../scripts/runner/gateway-preflight-contract.mjs";

const PROVIDER_ERROR_PATTERN = /\bprovider[_ ]error:\s*(\d{3})\b/i;
const HTTP_STATUS_PATTERN = /^\s*(\d{3})\b/;
export const PUBLIC_GATEWAY_PREFLIGHT_CLASSES = PUBLIC_GATEWAY_PREFLIGHT_FAILURE_CLASSES;
const PUBLIC_PREFLIGHT_CLASS_SET = new Set<string>(PUBLIC_GATEWAY_PREFLIGHT_CLASSES);

/** Keep provider response bodies out of public run pages. */
export function redactRunError(error: string, stage?: string): string {
  const providerMatch = error.match(PROVIDER_ERROR_PATTERN);
  if (providerMatch) return `provider_error: ${providerMatch[1]}`;

  if (stage === "provider_error") {
    const statusMatch = error.match(HTTP_STATUS_PATTERN);
    return statusMatch ? `provider_error: ${statusMatch[1]}` : "provider_error";
  }

  return error;
}

function recordPayload(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * Project persisted run events into a deliberately small public shape.
 *
 * Run events contain identifiers and diagnostics intended for operators:
 * submission/sandbox IDs, gateway request and response IDs, trace URLs, and
 * sometimes provider error text. The public run page must be an allowlist,
 * not a recursive JSON viewer, so new private fields remain hidden by default.
 */
export function redactRunEventPayload(type: string, payload: unknown): Record<string, unknown> {
  const source = recordPayload(payload);

  if (type === "run.failed" && source.stage === "gateway_preflight") {
    const finiteCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    return {
      stage: "gateway_preflight",
      ...(typeof source.preflight_class === "string" && PUBLIC_PREFLIGHT_CLASS_SET.has(source.preflight_class)
        ? { preflight_class: source.preflight_class }
        : {}),
      ...(typeof source.preflight_status === "number" && Number.isSafeInteger(source.preflight_status)
        && source.preflight_status >= 100 && source.preflight_status <= 599
        ? { preflight_status: source.preflight_status }
        : {}),
      ...(finiteCount(source.preflight_attempts) ? { preflight_attempts: source.preflight_attempts } : {}),
      ...(finiteCount(source.preflight_observed_bytes) ? { preflight_observed_bytes: source.preflight_observed_bytes } : {}),
      ...(finiteCount(source.preflight_observed_events) ? { preflight_observed_events: source.preflight_observed_events } : {}),
    };
  }

  if (type === "task.gateway_correlation") {
    const proxyRequests = Array.isArray(source.proxy_requests) ? source.proxy_requests : [];
    const responseStatuses = proxyRequests
      .map((request) => recordPayload(request).status)
      .filter((status): status is number => typeof status === "number" && Number.isFinite(status));
    const retryEvents = Array.isArray(source.pi_retry_events) ? source.pi_retry_events : [];

    return {
      ...(typeof source.task_id === "string" ? { task_id: source.task_id } : {}),
      proxy_request_count:
        typeof source.proxy_request_count === "number" && Number.isFinite(source.proxy_request_count)
          ? source.proxy_request_count
          : proxyRequests.length,
      ...(responseStatuses.length > 0 ? { response_statuses: responseStatuses } : {}),
      retry_count: retryEvents.length,
    };
  }

  const safeFields = (PUBLIC_RUN_EVENT_FIELDS as Record<string, readonly string[]>)[type] ?? [];
  const result: Record<string, unknown> = {};
  for (const key of safeFields) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}
