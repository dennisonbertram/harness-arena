import { trace } from "@opentelemetry/api";

export type LogLevel = "debug" | "info" | "warn" | "error";

export const MAX_LOG_BYTES = 64 * 1024;
const MAX_VALUE_CHARS = 24 * 1024;
const MAX_STRING_CHARS = 2_048;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 6;

const SECRET_KEY = /(?:authorization|api[_-]?key|secret|token|password|cookie|prompt|signature|credential)/i;
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const ABSOLUTE_URL_WITH_QUERY = /(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/gi;
const RELATIVE_URL_WITH_QUERY = /(^|[\s("'`])((?:\/)[^\s"'<>?]+)\?[^\s"'<>]*/g;

interface Budget {
  remaining: number;
}

export interface NormalizedError {
  error_schema: "v1";
  error_class: string;
  error_stage: string;
  error_fingerprint: string;
}

function configuredSecrets(): Set<string> {
  return new Set(Object.entries(process.env)
    // One-character environment flags are not secrets and would corrupt stable
    // schema values (for example, replacing every "1" in "v1").
    .filter(([key, value]) => SECRET_KEY.test(key) && typeof value === "string" && value.length >= 8)
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
  // Do not run global redaction regexes or configured-secret replacement over
  // attacker-sized input. Content outside this prefix cannot reach telemetry.
  const contentLimit = MAX_STRING_CHARS - 13;
  const wasTruncated = value.length > contentLimit;
  let safe = value.slice(0, contentLimit);
  // Longest first prevents overlapping values from leaving a secret suffix.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    const fullMatch = safe.indexOf(secret);
    if (fullMatch >= 0) {
      safe = replaceAll(safe, secret);
      continue;
    }
    // A secret crossing the truncation boundary cannot match in full. Compare
    // only a constant-size prefix, then discard the overlapping tail.
    if (wasTruncated && secret.length >= 8) {
      const probe = secret.slice(0, Math.min(64, secret.length));
      const overlap = safe.indexOf(probe);
      if (overlap >= 0 && overlap + secret.length > safe.length) safe = `${safe.slice(0, overlap)}[REDACTED]`;
    }
  }
  safe = safe.replace(ABSOLUTE_URL_WITH_QUERY, "$1");
  safe = safe.replace(RELATIVE_URL_WITH_QUERY, "$1$2");
  safe = safe.replace(BEARER, "Bearer [REDACTED]");
  return wasTruncated ? `${safe}...[Truncated]` : safe;
}

function errorClass(error: unknown): "error" | "type_error" | "range_error" | "syntax_error" | "abort_error" | "non_error" {
  if (!(error instanceof Error)) return "non_error";
  let name = "Error";
  try { name = error.name; } catch { /* hostile getters classify as a generic Error */ }
  switch (name) {
    case "TypeError": return "type_error";
    case "RangeError": return "range_error";
    case "SyntaxError": return "syntax_error";
    case "AbortError": return "abort_error";
    default: return "error";
  }
}

function safeStage(stage: string): string {
  return /^[a-z_]{1,64}$/.test(stage) ? stage : "unknown";
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function normalizeError(error: unknown, stage: string, secrets = configuredSecrets()): NormalizedError {
  void secrets; // Preserves the established call signature without inspecting untrusted details.
  // Never read Error.message, Error.stack, custom digest, or non-Error values:
  // those fields are provider/request controlled and must not enter telemetry.
  const error_class = errorClass(error);
  const error_stage = safeStage(stage);
  return {
    error_schema: "v1",
    error_class,
    error_stage,
    // This groups only public, allowlisted classifications; it cannot encode
    // a provider message, payload, stack, digest, or arbitrary thrown value.
    error_fingerprint: fingerprint(`${error_class}:${error_stage}`),
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
