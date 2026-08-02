import { trace } from "@opentelemetry/api";

export type LogLevel = "debug" | "info" | "warn" | "error";

const SECRET_KEY = /(?:authorization|api[_-]?key|secret|token|password|cookie|prompt|signature|credential)/i;
const QUERY_URL = /^(https?:\/\/[^\s?#]+)(?:\?[^\s#]*)?(?:#.*)?$/i;
const BEARER = /^Bearer\s+.+$/i;
const MAX_DEPTH = 8;

function configuredSecrets(): Set<string> {
  return new Set(Object.entries(process.env)
    .filter(([key, value]) => SECRET_KEY.test(key) && typeof value === "string" && value.length > 0)
    .map(([, value]) => value!));
}

function redactString(value: string, secrets: Set<string>): string {
  if (BEARER.test(value)) return "[REDACTED]";
  if (value.startsWith("/")) return value.split("?", 1)[0];
  if (QUERY_URL.test(value)) return value.replace(QUERY_URL, "$1");
  for (const secret of secrets) if (value.includes(secret)) return "[REDACTED]";
  return value;
}

/** Converts unknown data to JSON-safe telemetry without retaining sensitive input. */
export function redactLogValue(value: unknown, secrets = configuredSecrets(), seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (value instanceof Error) {
    const digest = typeof (value as Error & { digest?: unknown }).digest === "string"
      ? (value as Error & { digest: string }).digest : undefined;
    return {
      name: value.name,
      message: redactString(value.message, secrets),
      ...(digest ? { digest: redactString(digest, secrets) } : {}),
      // Stack is metadata only: cap it and run every line through the same redactor.
      stack: value.stack?.split("\n").slice(0, 8).map((line) => redactString(line, secrets)),
    };
  }
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => redactLogValue(item, secrets, seen, depth + 1));
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : redactLogValue(item, secrets, seen, depth + 1),
    ]));
  }
  return String(value);
}

function traceFields(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const { traceId, spanId } = span.spanContext();
  return traceId && spanId ? { trace_id: traceId, span_id: spanId } : {};
}

// One JSON line per call. Callers cannot override this envelope and values are
// recursively redacted before serialization so Vercel logs stay safe to query.
export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const deploymentSha = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "local";
  console.log(JSON.stringify({
    ...(redactLogValue(fields) as Record<string, unknown>),
    ts: new Date().toISOString(),
    level,
    event,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    deployment_sha: deploymentSha,
    ...traceFields(),
  }));
}
