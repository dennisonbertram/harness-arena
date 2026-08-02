import { trace } from "@opentelemetry/api";

export type LogLevel = "debug" | "info" | "warn" | "error";

export const MAX_LOG_BYTES = 64 * 1024;
const MAX_VALUE_CHARS = 24 * 1024;
const MAX_STRING_CHARS = 2_048;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 6;
const MAX_STACK_LINES = 8;

const SECRET_KEY = /(?:authorization|api[_-]?key|secret|token|password|cookie|prompt|signature|credential)/i;
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const ABSOLUTE_URL_WITH_QUERY = /(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/gi;
const RELATIVE_URL_WITH_QUERY = /(^|[\s("'`])((?:\/)[^\s"'<>?]+)\?[^\s"'<>]*/g;

interface Budget {
  remaining: number;
}

export interface NormalizedError {
  error_class: string;
  error_digest?: string;
  error_stage: string;
  error_message: string;
  error_stack: string[];
}

function configuredSecrets(): Set<string> {
  return new Set(Object.entries(process.env)
    .filter(([key, value]) => SECRET_KEY.test(key) && typeof value === "string" && value.length > 0)
    .map(([, value]) => value!));
}

function truncate(value: string, max = MAX_STRING_CHARS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 13))}...[Truncated]`;
}

function replaceAll(value: string, needle: string): string {
  return needle ? value.split(needle).join("[REDACTED]") : value;
}

function redactString(value: string, secrets: Set<string>): string {
  let safe = value;
  // Longest first prevents overlapping values from leaving a secret suffix.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) safe = replaceAll(safe, secret);
  safe = safe.replace(ABSOLUTE_URL_WITH_QUERY, "$1");
  safe = safe.replace(RELATIVE_URL_WITH_QUERY, "$1$2");
  safe = safe.replace(BEARER, "Bearer [REDACTED]");
  return truncate(safe);
}

export function normalizeError(error: unknown, stage: string, secrets = configuredSecrets()): NormalizedError {
  const isError = error instanceof Error;
  const candidate = typeof error === "object" && error !== null ? error as Record<string, unknown> : undefined;
  let digest: string | undefined;
  try {
    if (typeof candidate?.digest === "string") digest = redactString(candidate.digest, secrets);
  } catch {
    // A hostile thrown object may expose digest through a throwing getter.
  }
  let errorClass = isError ? "Error" : "NonError";
  let rawMessage = "unavailable error detail";
  try {
    if (isError) {
      errorClass = error.name || "Error";
      rawMessage = error.message;
    } else {
      rawMessage = typeof error === "string" ? error : String(error);
    }
  } catch {
    // Keep stable fallbacks for hostile thrown values.
  }
  let stack: string[] = [];
  try {
    if (isError && error.stack) stack = error.stack.split("\n").slice(0, MAX_STACK_LINES).map((line) => redactString(line, secrets));
  } catch {
    // Keep the stable empty stack when stack access itself is hostile.
  }
  return {
    error_class: redactString(errorClass, secrets),
    ...(digest ? { error_digest: digest } : {}),
    error_stage: redactString(stage, secrets),
    error_message: redactString(rawMessage, secrets),
    error_stack: stack,
  };
}

function consume(value: string, budget: Budget): string {
  if (budget.remaining <= 0) return "[Truncated]";
  const safe = truncate(value, Math.min(MAX_STRING_CHARS, budget.remaining));
  budget.remaining -= safe.length;
  return safe;
}

/** Converts unknown data to bounded, JSON-safe telemetry without retaining sensitive input. */
export function redactLogValue(
  value: unknown,
  secrets = configuredSecrets(),
  seen = new WeakSet<object>(),
  depth = 0,
  budget: Budget = { remaining: MAX_VALUE_CHARS },
): unknown {
  if (typeof value === "string") return consume(redactString(value, secrets), budget);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return consume(value.toString(), budget);
  if (typeof value === "undefined") return undefined;
  if (typeof value === "function" || typeof value === "symbol") return consume(String(value), budget);
  if (value instanceof Error) return redactLogValue(normalizeError(value, "unknown", secrets), secrets, seen, depth + 1, budget);
  if (depth >= MAX_DEPTH || budget.remaining <= 0) return "[Truncated]";
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactLogValue(item, secrets, seen, depth + 1, budget));
      if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
      return items;
    }
    const output: Record<string, unknown> = {};
    let keys: string[];
    try {
      keys = Object.keys(value).slice(0, MAX_OBJECT_KEYS);
    } catch {
      return "[Unserializable]";
    }
    for (const key of keys) {
      if (budget.remaining <= 0) break;
      if (SECRET_KEY.test(key)) {
        output[key] = "[REDACTED]";
        continue;
      }
      try {
        output[key] = redactLogValue((value as Record<string, unknown>)[key], secrets, seen, depth + 1, budget);
      } catch {
        output[key] = "[Unserializable]";
      }
    }
    const totalKeys = (() => { try { return Object.keys(value).length; } catch { return keys.length; } })();
    if (totalKeys > MAX_OBJECT_KEYS) output._truncated_keys = totalKeys - MAX_OBJECT_KEYS;
    return output;
  }
  return consume(String(value), budget);
}

function traceFields(): Record<string, string> {
  try {
    const span = trace.getActiveSpan();
    if (!span) return {};
    const { traceId, spanId } = span.spanContext();
    return traceId && spanId ? { trace_id: traceId, span_id: spanId } : {};
  } catch {
    return {};
  }
}

function safeWrite(record: Record<string, unknown>, fallback: Record<string, unknown>): void {
  try {
    let line = JSON.stringify(record);
    const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
    if (bytes(line) > MAX_LOG_BYTES) line = JSON.stringify({ ...fallback, fields_truncated: true });
    if (bytes(line) > MAX_LOG_BYTES) line = JSON.stringify({ level: fallback.level, event: "logger.record_truncated" });
    try { console.log(line); } catch { /* logging must never alter a request */ }
  } catch {
    try { console.log(JSON.stringify({ ...fallback, serialization_failed: true })); } catch { /* best effort */ }
  }
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  try {
    const envelope = {
      ts: new Date().toISOString(),
      level,
      event: truncate(event, 256),
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
      deployment_sha: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "local",
      ...traceFields(),
    };
    const safeFields = redactLogValue(fields) as Record<string, unknown>;
    safeWrite({ ...safeFields, ...envelope }, envelope);
  } catch {
    safeWrite({ level, event: "logger.failure" }, { level, event: "logger.failure" });
  }
}
