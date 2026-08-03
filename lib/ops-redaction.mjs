const REDACTED = "[REDACTED]";
const SENSITIVE_WORDS = new Set(["token", "secret", "password", "credential", "cookie", "authorization", "session", "auth"]);

export function normalizedKeyParts(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveCredentialKey(key) {
  const parts = normalizedKeyParts(key);
  if (parts.some((part) => SENSITIVE_WORDS.has(part))) return true;
  const compact = parts.join("");
  return ["authorization", "cookie", "password", "secret", "token", "credential", "session", "auth", "apikey"]
    .some((word) => compact.includes(word));
}

export function configuredSecrets(env) {
  return Object.entries(env)
    .filter(([key, value]) => isSensitiveCredentialKey(key) && typeof value === "string" && value.length > 0)
    .map(([, value]) => value);
}

export function sanitizeHttpUrls(value) {
  return String(value).replace(/https?:\/\/[^\s,"'<>]+/gi, (candidate) => {
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

function redactAssignments(value) {
  const quoted = /(["'])((?:\\.|(?!\1).){1,128})\1(\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}\]]+)/g;
  const bare = /\b([A-Za-z][A-Za-z0-9_. -]{0,80})(\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}\]]+)/g;
  return value
    .replace(quoted, (match, quote, key, separator) => isSensitiveCredentialKey(key) ? `${quote}${key}${quote}${separator}${REDACTED}` : match)
    .replace(bare, (match, key, separator) => isSensitiveCredentialKey(key) ? `${key}${separator}${REDACTED}` : match);
}

export function redactOpsText(value, secrets = []) {
  let output = sanitizeHttpUrls(value)
    .replace(/\b(Bearer|Basic)\s+[^\s,"'<>]+/gi, "$1 [REDACTED]")
    .replace(/\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, "$1: [REDACTED]");
  output = redactAssignments(output);
  const supplied = [...new Set(secrets.filter((item) => typeof item === "string" && item.length > 0))]
    .sort((left, right) => right.length - left.length);
  for (const secret of supplied) output = output.split(secret).join(REDACTED);
  return output;
}

export function redactOpsValue(value, secrets = [], key = "") {
  return redactValue(value, secrets, key, new WeakSet());
}

function redactValue(value, secrets, key, seen) {
  const presenceFlag = normalizedKeyParts(key).at(-1) === "present" && typeof value === "boolean";
  if (key && isSensitiveCredentialKey(key) && !presenceFlag) return REDACTED;
  if (typeof value === "string") return redactOpsText(value, secrets);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, "", seen));
  if (value instanceof Error) {
    const output = {
      name: redactOpsText(value.name, secrets),
      message: redactOpsText(value.message, secrets),
      stack: redactOpsText(value.stack ?? "", secrets),
    };
    if (value.cause !== undefined) output.cause = redactValue(value.cause, secrets, "cause", seen);
    for (const [name, item] of Object.entries(value)) {
      if (["name", "message", "stack", "cause"].includes(name)) continue;
      output[name] = redactValue(item, secrets, name, seen);
    }
    return output;
  }
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(item, secrets, name, seen)]));
}
