import { timingSafeEqual } from "node:crypto";
import { getStorage, PartialReadError } from "./storage";
import { getVoiceStorage } from "./voice-storage";

export const OPS_SCHEMA_VERSION = "ops.v1";
export const OPS_RECORD_KINDS = [
  { kind: "submissions", prefix: "submissions/" }, { kind: "runs", prefix: "runs/" },
  { kind: "competitions", prefix: "competitions/" }, { kind: "events", prefix: "events/" },
  { kind: "traces", prefix: "traces/" }, { kind: "voice_manifest", prefix: "voice/manifest.json" },
  { kind: "voice_judgments", prefix: "voice/judgments/" },
] as const;
export type OpsKind = typeof OPS_RECORD_KINDS[number]["kind"];
const MAX_LIMIT = 100;
export function opsAuthorized(value: string | null) {
  const expected = process.env.OPS_READ_TOKEN ?? ""; const actual = value?.replace(/^Bearer\s+/i, "") ?? "";
  const n = Math.max(Buffer.byteLength(expected), Buffer.byteLength(actual), 1), a = Buffer.alloc(n), b = Buffer.alloc(n);
  a.write(expected); b.write(actual);
  return expected.length > 0 && expected.length === actual.length && timingSafeEqual(a, b);
}
export function redactUrl(value: string) { try { const u = new URL(value); u.search = ""; return u.toString(); } catch { return value; } }
function paginate<T>(items: T[], options: { limit?: number; cursor?: string }) {
  const limit = options.limit ?? 50; if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: { code: "invalid_limit" } };
  let offset = 0; if (options.cursor) try { offset = JSON.parse(Buffer.from(options.cursor, "base64url").toString()).offset; if (!Number.isSafeInteger(offset) || offset < 0) throw 0; } catch { return { error: { code: "invalid_cursor" } }; }
  const page = items.slice(offset, offset + limit); return { items: page, next_cursor: offset + page.length < items.length ? Buffer.from(JSON.stringify({ offset: offset + page.length })).toString("base64url") : null, total: items.length };
}
export function createOpsReadService() {
  async function records(kind: OpsKind, runId?: string): Promise<any[]> {
    const s = getStorage();
    if (kind === "submissions") return s.listSubmissions(); if (kind === "runs") return s.listRuns(); if (kind === "competitions") return s.listCompetitions();
    if (kind === "events") return runId ? s.listRunEvents(runId) : [];
    if (kind === "voice_manifest") return [await getVoiceStorage().getManifest()].filter(Boolean);
    if (kind === "voice_judgments") return (await getVoiceStorage().listAllJudgments()).judgments;
    // Trace metadata derives from actual run documents, avoiding a second hand-maintained prefix list.
    return (await s.listRuns()).flatMap((run) => run.task_results.filter((t) => t.trace_blob_url).map((t) => ({ run_id: run.id, task_id: t.task_id, url: redactUrl(t.trace_blob_url!) })));
  }
  return { async list(kind: OpsKind, options: { limit?: number; cursor?: string; run_id?: string }) {
    if (!Number.isSafeInteger(options.limit ?? 50) || (options.limit ?? 50) < 1 || (options.limit ?? 50) > MAX_LIMIT) return { error: { code: "invalid_limit" } };
    try { return paginate(await records(kind, options.run_id), options); }
    catch (e) { return e instanceof PartialReadError ? { error: { code: "partial_read", prefix: e.prefix, missing: e.missing, total: e.total } } : { error: { code: "read_failed" } }; }
  }, async summary() { const [submissions, runs, competitions, voice] = await Promise.all([records("submissions"), records("runs"), records("competitions"), getVoiceStorage().listAllJudgments()]); return { submissions: submissions.length, runs: runs.length, competitions: competitions.length, voice_judgments: voice.judgments.length, unreadable: voice.unreadable, run_statuses: Object.groupBy(runs, (r) => r.status) }; } };
}
