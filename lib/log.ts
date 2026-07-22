export type LogLevel = "debug" | "info" | "warn" | "error";

// One JSON line per call: {ts, level, event, ...fields}. Every API route
// and the runner callback should log through this, not console.log
// directly, so logs are grep/jq-able in Vercel's log stream.
// Caller fields are spread first so the reserved envelope fields (ts,
// level, event) always win if a caller accidentally passes one of those
// keys in `fields`.
export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ...fields, ts: new Date().toISOString(), level, event }));
}
