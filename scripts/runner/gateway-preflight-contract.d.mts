export const GATEWAY_PREFLIGHT_CLASS: Readonly<{
  TOKEN_OBSERVED: "token_observed";
  TERMINAL_OBSERVED: "terminal_observed";
  LOCAL_SIDECAR_UNREACHABLE: "local_sidecar_unreachable";
  UPSTREAM_FETCH_FAILED: "upstream_fetch_failed";
  PROVIDER_REJECTED: "provider_rejected";
  PROVIDER_HTTP_ERROR: "provider_http_error";
  RESPONSE_STREAM_TIMEOUT: "response_stream_timeout";
  RESPONSE_STREAM_INCOMPLETE: "response_stream_incomplete";
  RESPONSE_STREAM_LIMIT: "response_stream_limit";
}>;

export const PUBLIC_GATEWAY_PREFLIGHT_FAILURE_CLASSES: readonly (
  | "local_sidecar_unreachable"
  | "upstream_fetch_failed"
  | "provider_rejected"
  | "provider_http_error"
  | "response_stream_timeout"
  | "response_stream_incomplete"
  | "response_stream_limit"
)[];

export const GATEWAY_PREFLIGHT_LIMITS: Readonly<{
  maxStreamBytes: number;
  maxStreamEvents: number;
}>;
