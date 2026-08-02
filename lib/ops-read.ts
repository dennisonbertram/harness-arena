import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getOpsReadAdapter, type OpsReadAdapter, type OpsRecordMetadata } from "./ops-read-adapter";
import { BLOB_PATHS } from "./blob-paths.mjs";

export const OPS_SCHEMA_VERSION = "ops.v1";
export const OPS_RECORD_KINDS = [
  { kind: "submissions", prefix: BLOB_PATHS.submissions, format: "json" },
  { kind: "runs", prefix: BLOB_PATHS.runs, format: "json" },
  { kind: "competitions", prefix: BLOB_PATHS.competitions, format: "json" },
  { kind: "events", prefix: BLOB_PATHS.events, format: "json" },
  { kind: "traces", prefix: BLOB_PATHS.traces, format: "text" },
  { kind: "voice_manifest", prefix: BLOB_PATHS.voiceManifest, format: "json" },
  { kind: "voice_judgments", prefix: BLOB_PATHS.voiceJudgments, format: "json" },
  { kind: "voice_audio_prompts", prefix: BLOB_PATHS.voiceAudioPrompts, format: "binary" },
  { kind: "voice_audio_responses", prefix: BLOB_PATHS.voiceAudioResponses, format: "binary" },
  { kind: "cleanup_operations", prefix: BLOB_PATHS.cleanupOperations, format: "json" },
  { kind: "cleanup_archives", prefix: BLOB_PATHS.cleanupArchives, format: "json" },
  { kind: "competition_resets", prefix: BLOB_PATHS.competitionResets, format: "json" },
  { kind: "archives", prefix: BLOB_PATHS.archives, format: "json" },
] as const;
export type OpsKind = typeof OPS_RECORD_KINDS[number]["kind"];
const MAX_LIMIT = 100, DEFAULT_LIMIT = 50, MAX_BYTES = 1_048_576, READ_TIMEOUT_MS = 3_000, MAX_SUMMARY_RECORDS = 2_000;

export function opsAuthorized(value: string | null) {
  const expected = process.env.OPS_READ_TOKEN ?? "", match = /^Bearer ([^\s]+)$/.exec(value ?? ""), actual = match?.[1] ?? "";
  const digest = (input: string) => createHash("sha256").update(input).digest();
  return expected.length > 0 && Boolean(match) && timingSafeEqual(digest(expected), digest(actual));
}
const SECRET_KEY = /(authorization|cookie|password|secret|token|api[_-]?key|credential)/i;
export function redactUrl(value: string) { try { const url = new URL(value); url.search = ""; return url.toString(); } catch { return value; } }
export function redactOpsValue(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    const secrets = Object.entries(process.env).filter(([name, item]) => SECRET_KEY.test(name) && item).map(([, item]) => item!);
    return secrets.includes(value) ? "[REDACTED]" : redactUrl(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactOpsValue(item));
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactOpsValue(item, name)])) : value;
}
type CursorPayload = { kind: OpsKind; prefix: string; blob_cursor?: string; snapshot_at: string; filter?: string; run_id?: string; root?: string; last_event?: { run_id: string; seq: number }; v?: 1 };
const cursorKey = () => process.env.OPS_READ_CURSOR_SECRET || process.env.OPS_READ_TOKEN || "";
export function encodeOpsCursor(payload: CursorPayload) { const body=Buffer.from(JSON.stringify({...payload,v:1})).toString("base64url");return `${body}.${createHmac("sha256",cursorKey()).update(body).digest("base64url")}`; }
export function decodeOpsCursor(cursor:string, context:Pick<CursorPayload,"kind"|"prefix">):CursorPayload { try {const [body,sig,...extra]=cursor.split(".");if(!body||!sig||extra.length)throw 0;const expected=createHmac("sha256",cursorKey()).update(body).digest(),actual=Buffer.from(sig,"base64url");if(actual.length!==expected.length||!timingSafeEqual(expected,actual))throw 0;const value=JSON.parse(Buffer.from(body,"base64url").toString()) as CursorPayload;if(value.v!==1||value.kind!==context.kind||value.prefix!==context.prefix)throw 0;return value;}catch{throw new Error("invalid_cursor");} }
const definition = (kind: OpsKind) => OPS_RECORD_KINDS.find((entry) => entry.kind === kind)!;
const safeSegment = (value: string | undefined) => Boolean(value && /^[A-Za-z0-9._-]+$/.test(value));
function prefixFor(kind: OpsKind, runId?: string) { const base=definition(kind).prefix; if(kind==="events"&&runId){if(!safeSegment(runId))throw new Error("invalid_filter");return `${base}${runId}/`;} return base; }
function pathnameFor(kind: OpsKind, input: Record<string,string|undefined>) {
  const def=definition(kind); if(kind==="voice_manifest")return def.prefix;
  if(kind==="events"){if(!safeSegment(input.run_id)||!/^\d+$/.test(input.seq??""))throw new Error("invalid_identifier");return `${def.prefix}${input.run_id}/${String(Number(input.seq)).padStart(10,"0")}.json`;}
  if(kind==="traces"){if(!safeSegment(input.run_id)||!safeSegment(input.task_id)||!safeSegment(input.name))throw new Error("invalid_identifier");return `${def.prefix}${input.run_id}/${input.task_id}/${input.name}`;}
  if(kind==="voice_judgments"){if(!safeSegment(input.evaluator_id)||!safeSegment(input.comparison_id))throw new Error("invalid_identifier");return `${def.prefix}${input.evaluator_id}/${input.comparison_id}.json`;}
  if(kind==="voice_audio_prompts"||kind==="voice_audio_responses"){if(!safeSegment(input.id))throw new Error("invalid_identifier");return `${def.prefix}${input.id}.wav`;}
  if(kind==="cleanup_archives"||kind==="competition_resets"||kind==="archives"){const path=input.path;if(!path||path.includes("..")||path.startsWith("/")||!`${def.prefix}${path}`.startsWith(def.prefix))throw new Error("invalid_identifier");return `${def.prefix}${path}`;}
  if(!safeSegment(input.id))throw new Error("invalid_identifier"); return `${def.prefix}${input.id}${["submissions","runs","competitions","cleanup_operations"].includes(kind)?".json":""}`;
}
export function createOpsReadService(adapter: OpsReadAdapter = getOpsReadAdapter()) {
  return {
    async list(kind: OpsKind, options: { limit?: number; cursor?: string; run_id?: string }) {
      const limit=options.limit??DEFAULT_LIMIT;if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_LIMIT)return {error:{code:"invalid_limit"}};
      let prefix:string;try{prefix=prefixFor(kind,options.run_id);}catch{return {error:{code:"invalid_filter"}};}
      let state:CursorPayload|undefined;try{state=options.cursor?decodeOpsCursor(options.cursor,{kind,prefix}):undefined;}catch{return {error:{code:"invalid_cursor"}};}
      const snapshot=state?.snapshot_at??new Date().toISOString();
      try {const page=await adapter.listPage({prefix,cursor:state?.blob_cursor,limit});const records=page.records.filter((record)=>record.uploaded_at<=snapshot);const integrity={event_holes:0,corrupt:0};let lastEvent=state?.last_event;if(kind==="events")for(const record of records){const match=/^events\/([^/]+)\/(\d+)\.json$/.exec(record.pathname);if(!match){integrity.corrupt++;continue;}const current={run_id:match[1],seq:Number(match[2])};const previous=lastEvent?.run_id===current.run_id?lastEvent.seq:0;if(current.seq>previous+1)integrity.event_holes+=current.seq-previous-1;if(current.seq>previous)lastEvent=current;}const partial=integrity.event_holes>0||integrity.corrupt>0;return {items:records,next_cursor:page.has_more&&page.cursor?encodeOpsCursor({kind,prefix,blob_cursor:page.cursor,snapshot_at:snapshot,run_id:options.run_id,last_event:lastEvent}):null,has_more:page.has_more,snapshot_at:snapshot,integrity,partial,errors:partial?[{code:"event_integrity",...integrity}]:[]};}
      catch{return {error:{code:"partial_read",prefix},partial:true};}
    },
    async read(kind:OpsKind,input:Record<string,string|undefined>){let pathname:string;try{pathname=pathnameFor(kind,input);}catch{return {error:{code:"invalid_identifier"}};}let result;try{result=await adapter.read({pathname,maxBytes:MAX_BYTES,timeoutMs:READ_TIMEOUT_MS});}catch{return {error:{code:"transient",error:"read_failed"}};}if(result.status!=="ok")return {error:{code:result.status,...result}};const def=definition(kind);let content:unknown=result.bytes.toString("utf8");if(def.format==="json")try{content=JSON.parse(content as string);}catch{return {error:{code:"corrupt",pathname}};}if(def.format==="binary")content=result.bytes.toString("base64");return {item:redactOpsValue(content),metadata:result.metadata};},
    async summary() {
      const counts:Record<string,number>={}, latest:Record<string,string|null>={};
      const runStates={queued:0,running:0,failed:0,stale:0};
      const integrity={event_holes:0,unreadable:0,corrupt:0};
      const scanned={records:0,complete:true,truncated:false};
      const lastEventSeq=new Map<string,number>();
      for(const def of OPS_RECORD_KINDS.filter((item)=>item.kind!=="archives")){
        let cursor:string|undefined;
        do {
          if(scanned.records>=MAX_SUMMARY_RECORDS){scanned.complete=false;scanned.truncated=true;break;}
          let page;
          try{page=await adapter.listPage({prefix:def.prefix,cursor,limit:Math.min(MAX_LIMIT,MAX_SUMMARY_RECORDS-scanned.records)});}
          catch{integrity.unreadable++;scanned.complete=false;break;}
          counts[def.kind]=(counts[def.kind]??0)+page.records.length;
          latest[def.kind]=page.records.reduce((value,record)=>!value||record.uploaded_at>value?record.uploaded_at:value,latest[def.kind]??null);
          scanned.records+=page.records.length;
          if(def.kind==="events") for(const record of page.records){const match=/^events\/([^/]+)\/(\d+)\.json$/.exec(record.pathname);if(!match){integrity.corrupt++;continue;}const seq=Number(match[2]),previous=lastEventSeq.get(match[1])??0;if(seq>previous+1)integrity.event_holes+=seq-previous-1;if(seq>previous)lastEventSeq.set(match[1],seq);}
          const inspectJson=["submissions","runs","competitions","events","voice_manifest","voice_judgments","cleanup_operations"].includes(def.kind);
          if(inspectJson) for(const record of page.records){let result;try{result=await adapter.read({pathname:record.pathname,maxBytes:MAX_BYTES,timeoutMs:READ_TIMEOUT_MS});}catch{integrity.unreadable++;continue;}if(result.status!=="ok"){integrity.unreadable++;continue;}try{const value=JSON.parse(result.bytes.toString()) as {status?:string;started_at?:string;created_at?:string};if(def.kind==="runs"){if(value.status==="queued")runStates.queued++;if(value.status==="running"){runStates.running++;const timestamp=Date.parse(value.started_at??value.created_at??"");if(Number.isFinite(timestamp)&&Date.now()-timestamp>20*60_000)runStates.stale++;}if(value.status==="failed")runStates.failed++;}}catch{integrity.corrupt++;}}
          cursor=page.has_more?page.cursor:undefined;
        } while(cursor);
      }
      return {counts,latest,run_states:runStates,integrity,scan:scanned};
    },
  };
}
