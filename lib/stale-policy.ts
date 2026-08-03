import { buildRunnerTasks } from "./tasks-for-runner";

const REAP_SAFETY_MARGIN_MINUTES = 10;
const REAP_WINDOW_ROUNDING_MINUTES = 10;
export interface OperationalRunState { status: string; created_at: string; dispatched_at?: string }

function defaultReapStaleMinutes() {
  const maxQuietSeconds=Math.max(0,...buildRunnerTasks().map((task)=>task.agent_timeout_sec+task.verifier_timeout_sec));
  const requiredMinutes=maxQuietSeconds/60+REAP_SAFETY_MARGIN_MINUTES;
  return Math.ceil(requiredMinutes/REAP_WINDOW_ROUNDING_MINUTES)*REAP_WINDOW_ROUNDING_MINUTES;
}
export function reapThresholdMs() { const fallback=defaultReapStaleMinutes(),configured=Number(process.env.REAP_STALE_MINUTES??fallback),minutes=Number.isFinite(configured)&&configured>0?configured:fallback;return minutes*60_000; }
export function isRunOperationallyStale(run:OperationalRunState,lastEventTs:string|undefined,now=Date.now()) {
  if(run.status!=="running"&&(run.status!=="queued"||!run.dispatched_at))return false;
  const eventTime=Date.parse(lastEventTs??run.created_at),dispatchTime=run.dispatched_at?Date.parse(run.dispatched_at):0;
  const lastActivity=Math.max(Number.isFinite(eventTime)?eventTime:0,Number.isFinite(dispatchTime)?dispatchTime:0);
  return now-lastActivity>reapThresholdMs();
}
