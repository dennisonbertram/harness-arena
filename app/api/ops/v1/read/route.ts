import { NextRequest, NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";
import { getVoiceStorage } from "@/lib/voice-storage";
import { OPS_SCHEMA_VERSION, opsAuthorized, redactUrl } from "@/lib/ops-read";
export const dynamic = "force-dynamic";
const h={"cache-control":"no-store"};
export async function GET(r:NextRequest){
  if(!opsAuthorized(r.headers.get("authorization"))) return NextResponse.json({error:"unauthorized"},{status:401,headers:h});
  const q=r.nextUrl.searchParams, kind=q.get("kind"), id=q.get("id"), s=getStorage(); let item:unknown;
  if(kind==="submissions"&&id)item=await s.getSubmission(id); else if(kind==="runs"&&id)item=await s.getRun(id); else if(kind==="competitions"&&id)item=await s.getCompetition(id);
  else if(kind==="voice_manifest")item=await getVoiceStorage().getManifest();
  else if(kind==="traces"){const run=q.get("run_id"),task=q.get("task_id"),name=q.get("name");if(!run||!task||!name)return NextResponse.json({error:"trace identifiers required"},{status:400,headers:h});const raw=await s.readOpsRecord(`traces/${run}/${task}/${name}`);if(!raw.found)return NextResponse.json({error:"not_found",partial:raw.partial??null},{status:404,headers:h});return NextResponse.json({schema_version:OPS_SCHEMA_VERSION,kind,run_id:run,task_id:task,name,content:String(raw.value)},{headers:h});}
  else return NextResponse.json({error:"unknown_kind"},{status:400,headers:h});
  if(!item)return NextResponse.json({error:"not_found"},{status:404,headers:h});
  const safe=typeof item==="object"&&item?JSON.parse(JSON.stringify(item,(k,v)=>k.toLowerCase().includes("url")&&typeof v==="string"?redactUrl(v):v)):item;
  return NextResponse.json({schema_version:OPS_SCHEMA_VERSION,kind,item:safe},{headers:h});
}
