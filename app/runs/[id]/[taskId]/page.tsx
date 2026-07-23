import { gunzipSync } from "node:zlib";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getStorage, type Storage } from "@/lib/storage";
import { getTasks } from "@/lib/tasks";
import { formatUsd, formatDuration } from "@/lib/format";
import { parseTrajectory } from "@/lib/trajectory";
import { reconstructRunProgress, type TaskState } from "@/lib/run-progress";
import { TrajectoryView } from "./TrajectoryView";

export const revalidate = 15;

async function readTraceText(storage: Storage, id: string, taskId: string, name: string): Promise<string | null> {
  const bytes = await storage.getTraceBytes(id, taskId, name);
  if (!bytes) return null;
  const isGz = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  return (isGz ? gunzipSync(bytes) : bytes).toString("utf-8");
}

type PageState = TaskState | "pending";
const STATE_STYLE: Record<PageState, { label: string; color: string }> = {
  passed: { label: "passed", color: "#22c55e" },
  failed: { label: "failed", color: "#ef4444" },
  running: { label: "running…", color: "var(--blue-700)" },
  verifying: { label: "verifying…", color: "var(--gray-700)" },
  pending: { label: "not started", color: "var(--gray-700)" },
};

export default async function TrajectoryPage({ params }: { params: Promise<{ id: string; taskId: string }> }) {
  const { id, taskId } = await params;
  // Only a real benchmark task id is valid — but do NOT require it to be in
  // run.task_results, which is empty until the run finishes (this is exactly
  // why mid-run trajectory links used to 404).
  if (!getTasks().some((t) => t.id === taskId)) notFound();

  const storage = getStorage();
  const run = await storage.getRun(id);
  if (!run) notFound();

  // Per-task status comes from the run doc once finished, else from the live
  // event stream while running.
  const fromResults = run.task_results.find((t) => t.task_id === taskId);
  const [submission, events, sessionText, verifierText] = await Promise.all([
    storage.getSubmission(run.submission_id),
    fromResults ? Promise.resolve([]) : storage.listRunEvents(id),
    readTraceText(storage, id, taskId, "session.jsonl"),
    readTraceText(storage, id, taskId, "verifier.txt"),
  ]);
  const fromEvents = fromResults ? undefined : reconstructRunProgress(events).tasks.find((t) => t.taskId === taskId);

  let state: PageState;
  let reward: number | null = null;
  let turns: number | undefined;
  let costUsd: number | undefined;
  let durationS: number | undefined;
  if (fromResults) {
    state = fromResults.passed ? "passed" : "failed";
    reward = fromResults.reward ?? null;
    turns = fromResults.turns;
    costUsd = fromResults.cost_usd;
    durationS = fromResults.duration_s;
  } else if (fromEvents) {
    state = fromEvents.state;
    turns = fromEvents.turns;
    costUsd = fromEvents.costUsd;
    durationS = fromEvents.durationS;
  } else {
    state = "pending";
  }

  const trajectory = sessionText
    ? parseTrajectory(sessionText)
    : { steps: [], summary: { turns: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, costUsd: null } };
  const badge = STATE_STYLE[state];

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "48px 24px" }}>
      <div style={{ fontSize: 14, marginBottom: 16, display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Link href={`/runs/${id}`}>← Run</Link>
        <Link href={`/tasks/${taskId}`}>Task overview</Link>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6, flexWrap: "wrap" }}>
        <h1 className="mono" style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.01em" }}>
          {taskId}
        </h1>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: "2px 10px",
            borderRadius: 9999,
            color: badge.color,
            border: `1px solid ${badge.color}`,
          }}
        >
          {badge.label}
        </span>
      </div>
      <p style={{ fontSize: 13, color: "var(--gray-700)", marginBottom: 24 }}>
        {submission?.agent_name ?? "unknown"}
        {submission?.prompt === "" ? " (baseline)" : ""} · run <span className="mono">{id.slice(0, 8)}</span>
      </p>

      <section
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "10px 28px",
          padding: "14px 0",
          borderTop: "1px solid var(--gray-alpha-400)",
          borderBottom: "1px solid var(--gray-alpha-400)",
          marginBottom: 28,
        }}
      >
        <Stat label="Steps" value={`${turns ?? trajectory.summary.turns}`} />
        <Stat label="Tokens in" value={trajectory.summary.tokensIn.toLocaleString()} />
        <Stat label="Tokens out" value={trajectory.summary.tokensOut.toLocaleString()} />
        <Stat label="Cache read" value={trajectory.summary.cacheRead.toLocaleString()} />
        <Stat
          label="Cost"
          value={
            costUsd !== undefined
              ? formatUsd(costUsd)
              : trajectory.summary.costUsd !== null
                ? formatUsd(trajectory.summary.costUsd)
                : "unmeasured"
          }
        />
        <Stat label="Duration" value={durationS !== undefined ? formatDuration(durationS) : "—"} />
      </section>

      {state === "pending" && trajectory.steps.length === 0 ? (
        <p style={{ fontSize: 14, color: "var(--gray-900)" }}>
          This task hasn&apos;t started yet in this run. The page auto-refreshes.
        </p>
      ) : (
        <TrajectoryView
          steps={trajectory.steps}
          summary={trajectory.summary}
          verifier={verifierText}
          passed={state === "passed"}
          reward={reward}
          durationS={durationS ?? null}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label" style={{ marginBottom: 2 }}>
        {label}
      </div>
      <div className="tabular-nums" style={{ fontSize: 18, fontWeight: 600 }}>
        {value}
      </div>
    </div>
  );
}
