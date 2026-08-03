import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import { gunzipSync } from "node:zlib";
import { getOpsReadAdapter, type OpsReadAdapter } from "./ops-read-adapter";
import { BLOB_PATHS } from "./blob-paths.mjs";
import { isRunOperationallyStale } from "./stale-policy";
import { configuredSecrets, redactOpsValue as redactSharedOpsValue, sanitizeHttpUrls } from "./ops-redaction.mjs";

export const OPS_SCHEMA_VERSION = "ops.v1";
export const OPS_RECORD_KINDS = [
  { kind: "submissions", prefix: BLOB_PATHS.submissions, format: "json" },
  { kind: "runs", prefix: BLOB_PATHS.runs, format: "json" },
  { kind: "competitions", prefix: BLOB_PATHS.competitions, format: "json" },
  { kind: "events", prefix: BLOB_PATHS.events, format: "json" },
  { kind: "traces", prefix: BLOB_PATHS.traces, format: "mixed" },
  { kind: "voice_manifest", prefix: BLOB_PATHS.voiceManifest, format: "json" },
  { kind: "voice_judgments", prefix: BLOB_PATHS.voiceJudgments, format: "json" },
  { kind: "voice_audio_prompts", prefix: BLOB_PATHS.voiceAudioPrompts, format: "binary" },
  { kind: "voice_audio_responses", prefix: BLOB_PATHS.voiceAudioResponses, format: "binary" },
  { kind: "cleanup_operations", prefix: BLOB_PATHS.cleanupOperations, format: "json" },
  { kind: "cleanup_archives", prefix: BLOB_PATHS.cleanupArchives, format: "mixed" },
  { kind: "competition_resets", prefix: BLOB_PATHS.competitionResets, format: "mixed" },
  { kind: "archives", prefix: BLOB_PATHS.archives, format: "mixed" },
] as const;
export type OpsKind = typeof OPS_RECORD_KINDS[number]["kind"];
const MAX_LIMIT = 100, DEFAULT_LIMIT = 50, MAX_BYTES = 750_000, SUMMARY_READ_BYTES = 262_144, READ_TIMEOUT_MS = 3_000, MAX_SUMMARY_RECORDS = 1_000;

export function opsAuthorized(value: string | null) {
  const expected = process.env.OPS_READ_TOKEN ?? "", match = /^Bearer ([^\s]+)$/.exec(value ?? ""), actual = match?.[1] ?? "";
  const digest = (input: string) => createHash("sha256").update(input).digest();
  const equal = timingSafeEqual(digest(expected), digest(actual));
  return expected.length > 0 && Boolean(match) && equal;
}
export function redactUrl(value: string) { return sanitizeHttpUrls(value); }
export function redactOpsValue(value: unknown, key = ""): unknown { return redactSharedOpsValue(value, configuredSecrets(process.env), key); }
type CursorPayload = { kind: OpsKind; prefix: string; blob_cursor?: string; snapshot_at: string; filter?: string; run_id?: string; root?: string; last_event?: { run_id: string; seq: number }; v?: 1 };
const cursorKey = () => {const value=process.env.OPS_READ_CURSOR_SECRET;if(!value||value===process.env.OPS_READ_TOKEN)throw new Error("cursor_secret_missing");return value;};
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
function decodeStoredContent(format:string,pathname:string,bytes:Buffer):{value?:unknown;error?:"corrupt"|"too_large"|"unsupported_binary"} {
  let decoded=bytes;
  if(bytes.length>=2&&bytes[0]===0x1f&&bytes[1]===0x8b){try{decoded=gunzipSync(bytes,{maxOutputLength:MAX_BYTES});}catch(error){return {error:error instanceof Error&&/larger|maxOutputLength|too large/i.test(error.message)?"too_large":"corrupt"};}}
  if(format==="binary")return {value:decoded.toString("base64")};
  let text:string;try{text=new TextDecoder("utf-8",{fatal:true}).decode(decoded);}catch{return {error:"unsupported_binary"};}
  if(decoded.includes(0)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))return {error:"unsupported_binary"};
  const logicalPath=pathname.toLowerCase().replace(/\.gz$/,"");
  const knownJson=logicalPath.endsWith(".json"),knownText=/\.(?:jsonl|ndjson|txt|log)$/.test(logicalPath);
  if(format==="json"||knownJson){try{return {value:JSON.parse(text)};}catch{return {error:"corrupt"};}}
  if(knownText)return {value:text};
  const trimmed=text.trimStart();
  if(trimmed.startsWith("{")||trimmed.startsWith("[")){try{return {value:JSON.parse(text)};}catch{return {value:text};}}
  return {value:text};
}
export function createOpsReadService(adapter: OpsReadAdapter = getOpsReadAdapter(),options:{summaryDeadlineMs?:number}={}) {
  const summaryDeadlineMs=options.summaryDeadlineMs??8_000;
  return {
    async list(kind: OpsKind, options: { limit?: number; cursor?: string; run_id?: string }) {
      const limit=options.limit??DEFAULT_LIMIT;if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_LIMIT)return {error:{code:"invalid_limit"}};
      try{cursorKey();}catch{return {error:{code:"cursor_secret_missing"}};}
      let prefix:string;try{prefix=prefixFor(kind,options.run_id);}catch{return {error:{code:"invalid_filter"}};}
      let state:CursorPayload|undefined;try{state=options.cursor?decodeOpsCursor(options.cursor,{kind,prefix}):undefined;}catch{return {error:{code:"invalid_cursor"}};}
      const snapshot=state?.snapshot_at??new Date().toISOString();
      try {const page=await adapter.listPage({prefix,cursor:state?.blob_cursor,limit});if(page.records.length>limit||page.records.length>MAX_LIMIT)return {error:{code:"page_item_limit",limit,received:page.records.length},partial:true};const records=page.records.filter((record)=>record.uploaded_at<=snapshot);const integrity={event_holes:0,corrupt:0};let lastEvent=state?.last_event;if(kind==="events")for(const record of records){const match=/^events\/([^/]+)\/(\d+)\.json$/.exec(record.pathname);if(!match){integrity.corrupt++;continue;}const current={run_id:match[1],seq:Number(match[2])};const previous=lastEvent?.run_id===current.run_id?lastEvent.seq:0;if(current.seq>previous+1)integrity.event_holes+=current.seq-previous-1;if(current.seq>previous)lastEvent=current;}const partial=integrity.event_holes>0||integrity.corrupt>0;return {items:records,next_cursor:page.has_more&&page.cursor?encodeOpsCursor({kind,prefix,blob_cursor:page.cursor,snapshot_at:snapshot,run_id:options.run_id,last_event:lastEvent}):null,has_more:page.has_more,snapshot_at:snapshot,integrity,partial,errors:partial?[{code:"event_integrity",...integrity}]:[]};}
      catch{return {error:{code:"partial_read",prefix},partial:true};}
    },
    async read(kind:OpsKind,input:Record<string,string|undefined>){let pathname:string;try{pathname=pathnameFor(kind,input);}catch{return {error:{code:"invalid_identifier"}};}let result;try{result=await adapter.read({pathname,maxBytes:MAX_BYTES,timeoutMs:READ_TIMEOUT_MS});}catch{return {error:{code:"transient",error:"read_failed"}};}if(result.status!=="ok")return {error:{code:result.status,...result}};const decoded=decodeStoredContent(definition(kind).format,pathname,result.bytes);if(decoded.error)return {error:{code:decoded.error,pathname}};return {item:redactOpsValue(decoded.value),metadata:result.metadata};},
    async summary() {
      const counts:Record<string,number>={}, latest:Record<string,string|null>={};
      const runStates={queued:0,running:0,failed:0,stale:0};
      const integrity={event_holes:0,unreadable:0,corrupt:0};
      const scanned={records:0,complete:true,truncated:false};
      const lastEventSeq=new Map<string,number>();
      const latestEvent=new Map<string,string>(),runCandidates:Array<{status:string;created_at:string;dispatched_at?:string;id?:string}>=[];
      const deadlineAt=Date.now()+summaryDeadlineMs;
      const withinDeadline=<T>(promise:Promise<T>)=>new Promise<T>((resolve,reject)=>{const remaining=deadlineAt-Date.now();if(remaining<=0){reject(new Error("summary_deadline"));return;}const timer=setTimeout(()=>reject(new Error("summary_deadline")),remaining);promise.then((value)=>{clearTimeout(timer);resolve(value);},(error)=>{clearTimeout(timer);reject(error);});});
      scan: for(const def of OPS_RECORD_KINDS.filter((item)=>item.kind!=="archives")){
        let cursor:string|undefined;
        do {
          if(scanned.records>=MAX_SUMMARY_RECORDS){scanned.complete=false;scanned.truncated=true;break;}
          let page;
          const pageLimit=Math.min(MAX_LIMIT,MAX_SUMMARY_RECORDS-scanned.records);
          try{page=await withinDeadline(adapter.listPage({prefix:def.prefix,cursor,limit:pageLimit}));}
          catch(error){scanned.complete=false;if(error instanceof Error&&error.message==="summary_deadline"){scanned.truncated=true;(scanned as typeof scanned&{reason?:string}).reason="deadline";break scan;}integrity.unreadable++;break;}
          if(page.records.length>pageLimit||page.records.length>MAX_LIMIT){scanned.complete=false;scanned.truncated=true;(scanned as typeof scanned&{reason?:string}).reason="page_item_limit";break scan;}
          counts[def.kind]=(counts[def.kind]??0)+page.records.length;
          latest[def.kind]=page.records.reduce((value,record)=>!value||record.uploaded_at>value?record.uploaded_at:value,latest[def.kind]??null);
          scanned.records+=page.records.length;
          if(def.kind==="events") for(const record of page.records){const match=/^events\/([^/]+)\/(\d+)\.json$/.exec(record.pathname);if(!match){integrity.corrupt++;continue;}const seq=Number(match[2]),previous=lastEventSeq.get(match[1])??0;if(seq>previous+1)integrity.event_holes+=seq-previous-1;if(seq>previous)lastEventSeq.set(match[1],seq);const previousTs=latestEvent.get(match[1]);if(!previousTs||record.uploaded_at>previousTs)latestEvent.set(match[1],record.uploaded_at);}
          const inspectJson=["submissions","runs","competitions","events","voice_manifest","voice_judgments","cleanup_operations"].includes(def.kind);
          if(inspectJson) for(const record of page.records){let result;try{result=await withinDeadline(adapter.read({pathname:record.pathname,maxBytes:SUMMARY_READ_BYTES,timeoutMs:READ_TIMEOUT_MS}));}catch(error){if(error instanceof Error&&error.message==="summary_deadline"){scanned.complete=false;scanned.truncated=true;(scanned as typeof scanned&{reason?:string}).reason="deadline";break scan;}integrity.unreadable++;continue;}if(result.status!=="ok"){integrity.unreadable++;continue;}try{const value=JSON.parse(result.bytes.toString()) as {id?:string;status?:string;started_at?:string;created_at?:string;dispatched_at?:string};if(def.kind==="runs"&&value.status&&value.created_at){runCandidates.push({id:value.id,status:value.status,created_at:value.created_at,dispatched_at:value.dispatched_at});if(value.status==="queued")runStates.queued++;if(value.status==="running")runStates.running++;if(value.status==="failed")runStates.failed++;}}catch{integrity.corrupt++;}}
          cursor=page.has_more?page.cursor:undefined;
        } while(cursor);
      }
      for(const run of runCandidates)if(isRunOperationallyStale(run,run.id?latestEvent.get(run.id):undefined))runStates.stale++;
      return {counts,latest,run_states:runStates,integrity,scan:scanned};
    },
  };
}
