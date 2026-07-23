import { gunzipSync } from "node:zlib";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getStorage, type Storage } from "@/lib/storage";
import { formatUsd, formatDuration } from "@/lib/format";
import { parseTrajectory } from "@/lib/trajectory";
import { TrajectoryView } from "./TrajectoryView";

export const revalidate = 15;

async function readTraceText(storage: Storage, id: string, taskId: string, name: string): Promise<string | null> {
  const bytes = await storage.getTraceBytes(id, taskId, name);
  if (!bytes) return null;
  const isGz = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  return (isGz ? gunzipSync(bytes) : bytes).toString("utf-8");
}

export default async function TrajectoryPage({ params }: { params: Promise<{ id: string; taskId: string }> }) {
  const { id, taskId } = await params;
  const storage = getStorage();
  const run = await storage.getRun(id);
  if (!run) notFound();
  const task = run.task_results.find((t) => t.task_id === taskId);
  if (!task) notFound();

  const submission = await storage.getSubmission(run.submission_id);
  const [sessionText, verifierText] = await Promise.all([
    readTraceText(storage, id, taskId, "session.jsonl"),
    readTraceText(storage, id, taskId, "verifier.txt"),
  ]);
  const trajectory = sessionText ? parseTrajectory(sessionText) : { steps: [], summary: { turns: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, costUsd: null } };

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
            color: task.passed ? "#22c55e" : "#ef4444",
            border: `1px solid ${task.passed ? "#22c55e" : "#ef4444"}`,
          }}
        >
          {task.passed ? "passed" : "failed"}
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
        <Stat label="Steps" value={`${task.turns ?? trajectory.summary.turns}`} />
        <Stat label="Tokens in" value={trajectory.summary.tokensIn.toLocaleString()} />
        <Stat label="Tokens out" value={trajectory.summary.tokensOut.toLocaleString()} />
        <Stat label="Cache read" value={trajectory.summary.cacheRead.toLocaleString()} />
        <Stat
          label="Cost"
          value={
            task.cost_usd !== undefined
              ? formatUsd(task.cost_usd)
              : trajectory.summary.costUsd !== null
                ? formatUsd(trajectory.summary.costUsd)
                : "unmeasured"
          }
        />
        <Stat label="Duration" value={task.duration_s !== undefined ? formatDuration(task.duration_s) : "—"} />
      </section>

      <TrajectoryView
        steps={trajectory.steps}
        summary={trajectory.summary}
        verifier={verifierText}
        passed={task.passed}
        reward={task.reward ?? null}
        durationS={task.duration_s ?? null}
      />
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
