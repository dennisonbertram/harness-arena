import { isNativeError, isProxy } from "node:util/types";

const REDACTED = "[REDACTED]";
const REDACTED_KEY = "[REDACTED_KEY]";
const REDACTED_ACCESSOR = "[REDACTED_ACCESSOR]";
export const MAX_REDACTION_TEXT_LENGTH = 64 * 1024;
const MAX_ASSIGNMENTS = 256;
const MAX_TRAVERSAL_PROPERTIES = 10_000;
const DIRECT_CREDENTIAL_SEGMENTS = new Set(["authorization", "cookie", "credential", "password", "secret"]);
const KEY_QUALIFIERS = new Set(["api", "auth", "encryption", "hmac", "private", "signing", "webhook"]);

export function normalizedKeyParts(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasCompound(parts, left, right) {
  return parts.some((part, index) => part === left && parts[index + 1] === right);
}

export function isSensitiveCredentialKey(key) {
  const parts = normalizedKeyParts(key);
  if (parts.length === 0) return false;
  if (parts.some((part) => DIRECT_CREDENTIAL_SEGMENTS.has(part))) return true;
  if (parts.some((part, index) => part === "token" && parts[index + 1] !== "count")) return true;
  if (hasCompound(parts, "api", "key") || hasCompound(parts, "session", "id") || hasCompound(parts, "session", "cookie")) return true;
  if (parts.some((part, index) => part === "key" && KEY_QUALIFIERS.has(parts[index - 1]))) return true;
  return parts.some((part) => new Set(["apikey", "authtoken", "authsecret", "authpassword", "sessionid", "sessioncookie", "signingkey", "privatekey"]).has(part));
}

export function isSecretEnvironmentName(key) {
  const parts = normalizedKeyParts(key);
  const last = parts.at(-1);
  if (["token", "secret", "password"].includes(last)) return true;
  return last === "key" && KEY_QUALIFIERS.has(parts.at(-2));
}

export function configuredSecrets(env) {
  return Object.entries(env)
    .filter(([key, value]) => isSecretEnvironmentName(key) && typeof value === "string" && value.length > 0)
    .map(([, value]) => value);
}

function boundedText(value) {
  const text = String(value);
  return text.length <= MAX_REDACTION_TEXT_LENGTH ? text : undefined;
}

function sanitizeBoundedHttpUrls(value) {
  return value.replace(/https?:\/\/[^\s,"'<>]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch { return "[REDACTED_URL]"; }
  });
}

export function sanitizeHttpUrls(value) {
  const text = boundedText(value);
  return text === undefined ? REDACTED : sanitizeBoundedHttpUrls(text);
}

function quotedEnd(value, start, quote) {
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === "\\") { index += 1; continue; }
    if (value[index] === quote) return index;
  }
  return -1;
}

function valueEnd(value, start) {
  if (value[start] === '"' || value[start] === "'") {
    const end = quotedEnd(value, start, value[start]);
    return end < 0 ? value.length : end + 1;
  }
  let end = start;
  while (end < value.length && !/[\s,;}\]&|)#]/.test(value[end])) end += 1;
  return end;
}

function assignmentAt(value, key, separatorIndex, nextIndex) {
  let cursor = separatorIndex + 1;
  while (cursor < value.length && /\s/.test(value[cursor])) cursor += 1;
  return { key, nextIndex, valueStart: cursor, valueEnd: valueEnd(value, cursor) };
}

function scanAssignments(value) {
  const assignments = [];
  for (let index = 0; index < value.length;) {
    const current = value[index];
    if (current === '"' || current === "'") {
      const end = quotedEnd(value, index, current);
      if (end < 0) {
        if (/[=:]/.test(value.slice(index + 1))) return undefined;
        break;
      }
      let separator = end + 1;
      while (separator < value.length && /\s/.test(value[separator])) separator += 1;
      if (value[separator] === ":" || value[separator] === "=") {
        let key = value.slice(index + 1, end);
        if (current === '"') {
          try { key = JSON.parse(value.slice(index, end + 1)); }
          catch { return undefined; }
        }
        assignments.push(assignmentAt(value, key, separator, end + 1));
        if (assignments.length > MAX_ASSIGNMENTS) return undefined;
      }
      index = end + 1;
      continue;
    }
    if (/[A-Za-z]/.test(current)) {
      let cursor = index + 1;
      while (cursor < value.length && /[A-Za-z0-9_. -]/.test(value[cursor])) cursor += 1;
      let separator = cursor;
      while (separator < value.length && /\s/.test(value[separator])) separator += 1;
      if ((value[separator] === ":" || value[separator] === "=") && !(value[separator] === ":" && value[separator + 1] === "/")) {
        assignments.push(assignmentAt(value, value.slice(index, cursor).trimEnd(), separator, cursor));
        if (assignments.length > MAX_ASSIGNMENTS) return undefined;
      }
      index = Math.max(cursor, index + 1);
      continue;
    }
    index += 1;
  }
  return assignments;
}

function redactAssignments(value) {
  const assignments = scanAssignments(value);
  if (!assignments) return REDACTED;
  const replacements = assignments
    .filter(({ key }) => isSensitiveCredentialKey(key))
    .map(({ valueStart, valueEnd: end }) => ({ start: valueStart, end }));
  let output = value;
  for (const { start, end } of replacements.reverse()) output = `${output.slice(0, start)}${REDACTED}${output.slice(end)}`;
  return output;
}

export function redactOpsText(value, secrets = []) {
  const text = boundedText(value);
  if (text === undefined) return REDACTED;
  const serialized = redactSerializedJson(text, secrets);
  if (serialized !== undefined) return serialized;
  let output = sanitizeBoundedHttpUrls(text)
    .replace(/\b(Bearer|Basic)\s+[^\s,"'<>]+/gi, "$1 [REDACTED]")
    .replace(/\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, "$1: [REDACTED]");
  output = redactAssignments(output);
  if (output === REDACTED) return output;
  const supplied = [...new Set(secrets.filter((item) => typeof item === "string" && item.length > 0))]
    .sort((left, right) => right.length - left.length);
  for (const secret of supplied) output = output.split(secret).join(REDACTED);
  return output;
}

function redactSerializedJson(text, secrets) {
  const start = text.search(/\S/);
  if (start < 0) return undefined;
  let end = text.length - 1;
  while (end >= start && /\s/.test(text[end])) end -= 1;
  const trimmed = text.slice(start, end + 1);
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  let parsed;
  try { parsed = JSON.parse(trimmed); }
  catch { return /[:=]/.test(trimmed) ? REDACTED : undefined; }
  try {
    const redacted = redactValue(parsed, secrets, "", { seen: new WeakSet(), remaining: MAX_ASSIGNMENTS });
    return `${text.slice(0, start)}${JSON.stringify(redacted)}${text.slice(end + 1)}`;
  } catch { return REDACTED; }
}

export function redactOpsValue(value, secrets = [], key = "") {
  try { return redactValue(value, secrets, key, { seen: new WeakSet(), remaining: MAX_TRAVERSAL_PROPERTIES }); }
  catch { return REDACTED; }
}

function uniqueKey(key, used) {
  if (!used.has(key)) { used.add(key); return key; }
  for (let suffix = 2; suffix <= MAX_ASSIGNMENTS; suffix += 1) {
    const candidate = `${key} [${suffix}]`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
  let candidate = REDACTED_KEY;
  while (used.has(candidate)) candidate += "_";
  used.add(candidate);
  return candidate;
}

function sanitizedKey(key, secrets) {
  const sanitized = redactOpsText(key, secrets);
  return sanitized === REDACTED && key !== REDACTED ? REDACTED_KEY : sanitized;
}

function defineEntries(output, entries, secrets, state, used) {
  for (const [name, descriptor] of entries) {
    state.remaining -= 1;
    if (state.remaining < 0) throw new Error("redaction_property_limit");
    const outputKey = uniqueKey(sanitizedKey(name, secrets), used);
    const outputValue = Object.hasOwn(descriptor, "value")
      ? redactValue(descriptor.value, secrets, name, state)
      : REDACTED_ACCESSOR;
    Object.defineProperty(output, outputKey, { value: outputValue, enumerable: true, configurable: true, writable: true });
  }
  return output;
}

function ownEnumerableDescriptors(value, excluded = new Set()) {
  if (isProxy(value)) return undefined;
  try {
    const entries = [];
    for (const name of Reflect.ownKeys(value)) {
      if (excluded.has(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor) return undefined;
      if (descriptor.enumerable) entries.push([name, descriptor]);
    }
    return entries;
  } catch { return undefined; }
}

function ownDescriptor(value, name) {
  try { return Object.getOwnPropertyDescriptor(value, name); }
  catch { return undefined; }
}

function descriptorValue(descriptor, secrets, key, state, fallback = "") {
  if (!descriptor) return fallback;
  return Object.hasOwn(descriptor, "value") ? redactValue(descriptor.value, secrets, key, state) : REDACTED_ACCESSOR;
}

function redactValue(value, secrets, key, state) {
  const presenceFlag = normalizedKeyParts(key).at(-1) === "present" && typeof value === "boolean";
  if (key && isSensitiveCredentialKey(key) && !presenceFlag) return REDACTED;
  if (typeof value === "string") return redactOpsText(value, secrets);
  if (typeof value === "function") return REDACTED;
  if (!value || typeof value !== "object") return value;
  if (isProxy(value)) return REDACTED;
  if (state.seen.has(value)) return REDACTED;
  state.seen.add(value);
  if (Array.isArray(value)) {
    const length = ownDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ASSIGNMENTS) return REDACTED;
    const output = new Array(length);
    const entries = ownEnumerableDescriptors(value);
    if (!entries) return REDACTED;
    return defineEntries(output, entries, secrets, state, new Set());
  }
  if (isNativeError(value)) {
    const excluded = new Set(["name", "message", "stack", "cause"]);
    const output = {
      name: descriptorValue(ownDescriptor(value, "name"), secrets, "name", state, "Error"),
      message: descriptorValue(ownDescriptor(value, "message"), secrets, "message", state),
      stack: descriptorValue(ownDescriptor(value, "stack"), secrets, "stack", state),
    };
    const used = new Set(Object.keys(output));
    const cause = ownDescriptor(value, "cause");
    if (cause) {
      output.cause = descriptorValue(cause, secrets, "cause", state);
      used.add("cause");
    }
    const entries = ownEnumerableDescriptors(value, excluded);
    return entries ? defineEntries(output, entries, secrets, state, used) : REDACTED;
  }
  const entries = ownEnumerableDescriptors(value);
  return entries ? defineEntries({}, entries, secrets, state, new Set()) : REDACTED;
}
